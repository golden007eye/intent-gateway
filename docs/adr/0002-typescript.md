# ADR-0002: TypeScript for the gateway

Status: accepted · 2026-10-15

## Context

The gateway's users are developers running MCP agents (Claude Code, OpenClaw, custom clients). The gateway ships as a Docker image and must be easy to read, audit and contribute to.

## Decision

TypeScript, strict mode, ESM, on the current Node LTS, managed with pnpm. Tests with vitest, lint with eslint, module boundaries with dependency-cruiser.

## Consequences

The MCP TypeScript SDK and its ecosystem are first-class here. Contributors from the MCP community meet a familiar stack. Shared cryptographic formats with Intent Cloud (snapshots, signed approvals, hash-chain entries) are defined by their wire format and test vectors, not by shared code.
