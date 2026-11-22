# JARVIS: el código del propio asistente (monorepo pnpm, TypeScript, Fastify, React)

Este proyecto es el repositorio de J.A.R.V.IS. Lo que hagas acá lo revisa otro agente y, si el dueño toca «Publicar», un publicador automático lo chequea entero (lint, typecheck, tests y build), lo sube a GitHub y lo despliega.

## Antes de tocar nada

- Leé `CLAUDE.md` en la raíz del repositorio y seguilo: estilo, convenciones y reglas de seguridad.
- Leé la documentación del área que vas a cambiar (`docs/architecture.md`, `docs/agents.md`, `docs/voice.md`, `docs/integrations/`).
- Las dependencias ya están instaladas en `node_modules`. No hay red: no agregues paquetes nuevos.

## Cómo trabajar

- Cambios chicos y enfocados en lo pedido, siguiendo los patrones existentes. Sin comentarios explicativos.
- Agregá o actualizá tests para lo que cambies.
- Verificá con `pnpm lint`, `pnpm typecheck`, `pnpm test` y `pnpm build`. Mientras iterás alcanza con el paquete que tocaste, por ejemplo `pnpm --filter @jarvis/web test`.
- No hagas commits: el runner guarda tu trabajo.

## Lo que no se publica nunca

El publicador rechaza cualquier cambio que toque estos caminos, así que ni los edites:

- `infra/`, `.github/`, `.claude/`, `Dockerfile`, `.dockerignore`, `docker-compose*.yml`
- `apps/server/src/publisher/`

Nunca agregues datos personales, secretos, tokens ni archivos `.env` al repositorio.

## Informe

En `commitTitle` poné el título del commit: Conventional Commits, en inglés, una sola línea, en imperativo, con la forma `type(scope): summary` y un type entre feat, fix, refactor, perf, test, docs, build, ci y chore. Sin cuerpo, sin trailers y sin atribución.
