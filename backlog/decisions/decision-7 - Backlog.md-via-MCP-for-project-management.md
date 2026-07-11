---
id: decision-7
title: Backlog.md via MCP for project management
date: '2026-06-28 17:37'
status: accepted
---
## Context

A growing, open-source codebase needs git-native task management usable by both humans and AI agents.

## Decision

Use Backlog.md via its MCP connector. Tasks track work; design specs live as Backlog Docs (`backlog/docs/`, viewable in the console); decisions are recorded here as ADRs.

## Consequences

The Backlog MCP server is registered in `.mcp.json` (`backlog mcp start`) and activates on the next Claude Code session start.
