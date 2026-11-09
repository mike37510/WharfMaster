<?php
declare(strict_types=1);

namespace App\Http;

/**
 * Minimal method + path router with {param} placeholders.
 */
final class Router
{
    /** @var list<array{methods:list<string>, pattern:string, regex:string, names:list<string>, handler:callable}> */
    private array $routes = [];

    /**
     * @param string|list<string> $methods
     * @param callable $handler fn(Request $request, array $params): Response
     */
    public function add(string|array $methods, string $pattern, callable $handler): void
    {
        $methods = array_map('strtoupper', (array) $methods);
        $names = [];
        $regex = preg_replace_callback(
            '/\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]+))?\}/',
            static function (array $m) use (&$names): string {
                $names[] = $m[1];
                $inner = $m[2] ?? '[^/]+';
                return '(' . $inner . ')';
            },
            $pattern
        );
        $regex = '#^' . $regex . '$#';
        $this->routes[] = [
            'methods' => $methods,
            'pattern' => $pattern,
            'regex' => $regex,
            'names' => $names,
            'handler' => $handler,
        ];
    }

    public function get(string $pattern, callable $handler): void
    {
        $this->add('GET', $pattern, $handler);
    }

    public function post(string $pattern, callable $handler): void
    {
        $this->add('POST', $pattern, $handler);
    }

    public function put(string $pattern, callable $handler): void
    {
        $this->add('PUT', $pattern, $handler);
    }

    public function delete(string $pattern, callable $handler): void
    {
        $this->add('DELETE', $pattern, $handler);
    }

    public function dispatch(Request $request, string $path): Response
    {
        $hit = $this->match($request, $path);
        if ($hit === null) {
            return Response::error('Introuvable', 404);
        }
        return ($hit['handler'])($request, $hit['params']);
    }

    /**
     * @return array{handler:callable, params:array<string, mixed>}|null
     */
    public function match(Request $request, string $path): ?array
    {
        $method = strtoupper($request->method);
        foreach ($this->routes as $route) {
            if (!in_array($method, $route['methods'], true)) {
                continue;
            }
            if (!preg_match($route['regex'], $path, $m)) {
                continue;
            }
            array_shift($m);
            $params = [];
            foreach ($route['names'] as $i => $name) {
                $params[$name] = $m[$i] ?? null;
            }
            return ['handler' => $route['handler'], 'params' => $params];
        }
        return null;
    }
}
