#!/usr/bin/env php
<?php
declare(strict_types=1);

$root = dirname(__DIR__);
require $root . '/src/Support/RuntimeInit.php';

$var = App\Support\RuntimeInit::ensure($root);
fwrite(STDOUT, "WharfMaster init OK — var={$var}\n");
exit(0);
