<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;

final class SchedulesController extends BaseController
{
    public function listSchedules(Request $request, array $user): Response
    {
        $stackId = $request->query('stackId');
        $endpointId = $request->query('endpointId');
        $sid = $stackId !== null && $stackId !== '' ? (int) $stackId : null;
        $eid = $endpointId !== null && $endpointId !== '' ? (int) $endpointId : null;
        if ($sid !== null) {
            $stack = $this->repo->getStack($sid);
            if (!$stack || !$this->canAccessStack($stack, $user)) {
                return Response::error('Stack introuvable', 404);
            }
        } elseif (!Ownership::isGlobalAdmin($user)) {
            return Response::error('Accès administrateur requis', 403);
        }
        $rows = $this->repo->listSchedules($sid, $eid);
        return Response::json(['Items' => array_map([$this, 'formatSchedule'], $rows)]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function getScheduleApi(int $id, array $user): Response
    {
        $row = $this->repo->getSchedule($id);
        if (!$row) {
            return Response::error('Planification introuvable', 404);
        }
        if (!$this->canAccessSchedule($row, $user)) {
            return Response::error('Accès refusé', 403);
        }
        return Response::json($this->formatSchedule($row));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function createSchedule(Request $request, array $user): Response
    {
        $body = $request->json();
        $stackId = (int) ($body['StackId'] ?? $body['stack_id'] ?? $body['TargetId'] ?? 0);
        $action = strtolower(trim((string) ($body['Action'] ?? $body['action'] ?? '')));
        $cron = trim((string) ($body['Cron'] ?? $body['cron_expr'] ?? $body['CronExpr'] ?? ''));
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? ''));
        $tz = trim((string) ($body['Timezone'] ?? $body['timezone'] ?? 'UTC')) ?: 'UTC';
        if (!in_array($action, ['start', 'stop', 'restart'], true)) {
            return Response::error('Action invalide (start|stop|restart)', 400);
        }
        if (!CronExpr::isValid($cron)) {
            return Response::error('Expression cron invalide (5 champs)', 400);
        }
        $stack = $this->repo->getStack($stackId);
        if (!$stack || !$this->canOperateStack($stack, $user)) {
            return Response::error('Stack introuvable ou accès refusé', 404);
        }
        if ($name === '') {
            $name = $action . ' · ' . $stack['name'];
        }
        $next = CronExpr::nextAfter($cron, time());
        $row = $this->repo->createSchedule(
            $name,
            (int) $stack['endpoint_id'],
            'stack',
            $stackId,
            $action,
            $cron,
            $tz,
            Ownership::username($user),
            $next,
        );
        $this->audit($user, 'schedule.create', 'Planification créée pour « ' . $stack['name'] . ' »', $request, [
            'scheduleId' => (int) ($row['id'] ?? 0),
            'action' => $action,
            'cron' => $cron,
        ]);
        return Response::json($this->formatSchedule($row), 201);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function updateSchedule(int $id, Request $request, array $user): Response
    {
        $row = $this->repo->getSchedule($id);
        if (!$row || !$this->canAccessSchedule($row, $user)) {
            return Response::error('Planification introuvable', 404);
        }
        if (!$this->canOperateSchedule($row, $user)) {
            return Response::error('Permissions insuffisantes', 403);
        }
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? $row['name']));
        $action = strtolower(trim((string) ($body['Action'] ?? $body['action'] ?? $row['action'])));
        $cron = trim((string) ($body['Cron'] ?? $body['cron_expr'] ?? $body['CronExpr'] ?? $row['cron_expr']));
        $tz = trim((string) ($body['Timezone'] ?? $body['timezone'] ?? $row['timezone'])) ?: 'UTC';
        $enabled = array_key_exists('Enabled', $body) || array_key_exists('enabled', $body)
            ? !empty($body['Enabled'] ?? $body['enabled'])
            : ((int) $row['enabled'] === 1);
        if (!in_array($action, ['start', 'stop', 'restart'], true)) {
            return Response::error('Action invalide', 400);
        }
        if (!CronExpr::isValid($cron)) {
            return Response::error('Expression cron invalide', 400);
        }
        $next = $enabled ? CronExpr::nextAfter($cron, time()) : null;
        $updated = $this->repo->updateSchedule($id, $name, $action, $cron, $tz, $enabled, $next);
        $this->audit($user, 'schedule.update', 'Planification mise à jour', $request, ['scheduleId' => $id]);
        return Response::json($this->formatSchedule($updated ?? $row));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function deleteSchedule(int $id, Request $request, array $user): Response
    {
        $row = $this->repo->getSchedule($id);
        if (!$row || !$this->canAccessSchedule($row, $user)) {
            return Response::error('Planification introuvable', 404);
        }
        if (!$this->canOperateSchedule($row, $user)) {
            return Response::error('Permissions insuffisantes', 403);
        }
        $this->repo->deleteSchedule($id);
        $this->audit($user, 'schedule.delete', 'Planification supprimée', $request, ['scheduleId' => $id]);
        return Response::empty(204);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function runScheduleNow(int $id, Request $request, array $user): Response
    {
        $row = $this->repo->getSchedule($id);
        if (!$row || !$this->canAccessSchedule($row, $user)) {
            return Response::error('Planification introuvable', 404);
        }
        if (!$this->canOperateSchedule($row, $user)) {
            return Response::error('Permissions insuffisantes', 403);
        }
        return $this->executeScheduleRow($row, $request, $user, true);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function runDueSchedules(Request $request, array $user): Response
    {
        if (!Ownership::isGlobalAdmin($user)) {
            return Response::error('Accès refusé', 403);
        }
        $now = time();
        $due = $this->repo->listDueSchedules($now);
        $results = [];
        foreach ($due as $row) {
            $res = $this->executeScheduleRow($row, $request, $user, false);
            $results[] = [
                'Id' => (int) $row['id'],
                'Status' => $res->status,
            ];
        }
        return Response::json(['Ran' => count($results), 'Results' => $results]);
    }

    /**
     * @param array<string, mixed> $row
     * @param array{id:int,username:string,role:int} $user
     */
}
