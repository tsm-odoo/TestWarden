#!/bin/sh
# Prints the newest X.Y or saas-X.Y branch of odoo/odoo, to know when .github/odoo-ref can be bumped.
git ls-remote --heads https://github.com/odoo/odoo \
    | sed 's#.*refs/heads/##' \
    | grep -E '^(saas-)?[0-9]+\.[0-9]+$' \
    | awk '{v=$0; sub(/^saas-/,"",v); print v" "$0}' \
    | sort -V | tail -1 | cut -d' ' -f2
