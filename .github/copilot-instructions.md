# Copilot Instructions

## Project Overview

Turtle-Hook is a service that updates a SPARQL endpoint to reflect changes to RDF-Turtle files in a GitHub repository. It provides a webhook and web/REST interface using the [ghact](https://deno.land/x/ghact) library.

## Technology Stack

- **Runtime**: [Deno](https://deno.land/) (TypeScript runtime)
- **Language**: TypeScript
- **HTTP Framework**: ghact (GitHub Action/Webhook framework for Deno)
- **Triple Store**: Blazegraph (SPARQL endpoint)
- **Container**: Docker

## Project Structure

- `src/` - Source code
  - `main.ts` - Application entry point, creates GHActServer
  - `worker.ts` - Worker that processes jobs (LOAD/DROP SPARQL operations)
  - `deps.ts` - External dependencies (re-exports from ghact)
- `config/` - Configuration files
  - `config.ts` - Application configuration (SPARQL endpoint, source repository)
- `Dockerfile` - Container definition
- `.devcontainer/` - VS Code dev container configuration

## Code Style and Conventions

- Use TypeScript with Deno
- Import external dependencies through `src/deps.ts`
- Use URL imports for Deno modules (e.g., `https://deno.land/x/...`)
- Follow Deno's built-in formatter and linter (`deno fmt`, `deno lint`)
- Prefer `const` over `let` where possible
- Use arrow functions for callbacks and short functions

## Running the Application

```bash
# Run the main server
deno run --allow-net --allow-read --allow-write --allow-run=git --allow-env src/main.ts

# Format code
deno fmt

# Lint code
deno lint

# Cache dependencies
deno cache src/deps.ts
```

## Docker

```bash
# Build the Docker image
docker build -t turtle-hook .

# Run the container
docker run -p 4505:4505 turtle-hook
```

## Key Concepts

- **SPARQL Operations**: The worker handles three types of operations on `.ttl` files:
  - `LOAD` - For newly added files
  - `DROP` - For removed files
  - `UPDATE` (DROP + LOAD) - For modified files
- **Graph URIs**: Generated from the file name, prefixed with `https://treatment.plazi.org/id`. This prefix should not be changed as removing previous versions depends on it remaining consistent.
- **Jobs**: Processed asynchronously via Web Workers

## Contribution Guidelines

- Keep dependencies minimal and use Deno-compatible modules
- Test changes with Docker build to ensure compatibility
- Maintain backwards compatibility with the SPARQL endpoint interface
- Update `src/deps.ts` when adding new external dependencies
