# Code Review

## goal
Review recent changes for bugs, security issues, and code quality problems.

## agents

### bug-hunter
Read the recent git diff (last commit or staged changes). Look for logic errors, off-by-one mistakes, null/undefined issues, race conditions, and missing error handling. Write specific findings with file paths and line numbers.

### security-reviewer
Read the recent git diff. Check for security issues: injection vulnerabilities (SQL, XSS, command), hardcoded secrets, insecure defaults, missing input validation, and OWASP top 10 issues. Write specific findings with severity ratings.

### style-checker
Read the recent git diff. Check for code style issues: inconsistent naming, dead code, overly complex functions, missing types, and violations of project conventions. Write findings sorted by importance.

## sandbox
developer

## synthesize
Read all agent output files. Produce a unified review with sections for Critical (must fix), Important (should fix), and Minor (nice to fix). Deduplicate findings that multiple reviewers flagged. For each finding, include the file, line, issue, and suggested fix.

## output
Write findings to `.expo/output/code-review.md`
