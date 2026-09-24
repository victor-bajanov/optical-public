#!/usr/bin/env python3
"""Read Problem JSON from stdin, validate against solver schema, exit 0/1."""
import sys

from pydantic import ValidationError
from solver.schema import Problem


def main() -> int:
    raw = sys.stdin.read()
    try:
        Problem.model_validate_json(raw)
    except ValidationError as exc:
        print(exc.json(indent=2), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
