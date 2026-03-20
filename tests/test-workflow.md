# Test Workflow: Project File Summary

## goal
Summarize what tools are available in this project

## agents

### file-scanner
List the TypeScript files in the src/ directory using ls. Write a bullet list of filenames to the output file.

### line-counter
Count the total lines of TypeScript code in src/ using wc -l. Write the count to the output file.

## sandbox
permissive

## synthesize
Read the agent output files and write a one-paragraph summary combining both agents' findings.

## output
Write findings to `.expo/output/test-synthesis.md`
