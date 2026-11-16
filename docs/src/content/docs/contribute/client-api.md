---
title: Connect an external client
description: Discover the authenticated HTTP contract without depending on a client source checkout.
sidebar:
  order: 20
---

External clients connect to Nod over its existing HTTP and server-sent event routes. Nod does not need a Flutter SDK, mobile build scripts, or a client checkout.

## Discover the contract

Send `GET /api/client/capabilities` with the owner's configured `NOD_AUTH_TOKEN` as a bearer token. The normal host, origin, and cross-site guards run before discovery. Cookie-only access does not enable this endpoint. A valid token is never returned in its response.

The response declares `contractVersion: 1`, bearer authentication, attachment availability, core endpoint paths and methods, event names, and error-recovery categories. Reject an unsupported contract before sending work. Discovery describes the core protocol; it is not a promise that every feature-specific route or future presentation has client support.

Native connections need bearer authentication even on loopback. Use the exact origin configured by `NOD_PUBLIC_URL`. Existing private account writes still need that origin; do not remove origin checks to accept a native client. Use HTTPS outside the supported loopback development path. Never place owner tokens in build defines, URLs, logs, or test fixtures.

## Core routes

| Purpose                     | Method | Path                       |
| --------------------------- | ------ | -------------------------- |
| Discovery                   | GET    | `/api/client/capabilities` |
| Session                     | GET    | `/api/session`             |
| State                       | GET    | `/api/state`               |
| History and message context | GET    | `/api/messages`            |
| Events                      | GET    | `/api/events`              |
| Send                        | POST   | `/api/messages`            |
| Stop                        | POST   | `/api/thread/stop`         |

Feature clients also use existing routes for tasks, private entry, account settings, files, audio, and other supported workflows. Discovery does not duplicate these server implementations or grant permission for actions.

## Change the contract safely

`src/shared/client-api.ts` contains core wire schemas and discovery metadata. Preserve server authorization and input validation: these schemas describe the client boundary, not a replacement for route guards. The protocol can accept additive response fields; semantic or required-field changes still need explicit compatibility review.

Server-owned synthetic examples live in `tests/fixtures/client-api`. Run `pnpm exec tsx --test tests/client-api.test.ts tests/accounts.test.ts` and `pnpm run lint` for focused checks. Database-backed application bootstrap assertions in `tests/channel-application.test.ts` additionally validate real route responses; run them only with the documented isolated integration harness and disposable database.

A client repository keeps its own parsers and fixture tests. Neither repository imports the other's files. Before sharing a client build, test the exact server and client versions together with disposable data. Fixture parsing and discovery tests alone do not prove end-to-end feature parity.
