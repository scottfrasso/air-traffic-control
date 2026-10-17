# Review guidance

- Money is integer cents. Any float arithmetic on prices is a bug.
- Nothing user-supplied may reach a shell, a file path or SQL unescaped.
- Every exported function that changes behaviour needs a test.
