<?php
declare(strict_types=1);

namespace App\Security;

final class PasswordPolicy
{
    public static function validate(string $password): ?string
    {
        if (strlen($password) < 10) {
            return 'Le mot de passe doit contenir au moins 10 caractères';
        }
        if (strlen($password) > 200) {
            return 'Le mot de passe est trop long';
        }
        if (!preg_match('/[A-Za-z]/', $password) || !preg_match('/[0-9]/', $password)) {
            return 'Le mot de passe doit contenir au moins une lettre et un chiffre';
        }
        return null;
    }
}
