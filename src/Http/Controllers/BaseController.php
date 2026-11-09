<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\AppContext;

/**
 * Proxies property/method access to AppContext so domain methods can keep $this->repo etc.
 */
abstract class BaseController
{
    public function __construct(protected AppContext $ctx)
    {
    }

    public function __get(string $name): mixed
    {
        return $this->ctx->$name;
    }

    public function __isset(string $name): bool
    {
        return isset($this->ctx->$name);
    }

    public function __call(string $name, array $arguments): mixed
    {
        return $this->ctx->$name(...$arguments);
    }
}
