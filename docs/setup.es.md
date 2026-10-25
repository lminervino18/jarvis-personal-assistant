# Guía de instalación (español)

Esta guía lleva a J.A.R.V.IS desde cero hasta usarlo en el celular. El detalle técnico de cada paso está en [deploy.md](deploy.md) y las tareas de mantenimiento en [runbook.md](runbook.md).

## Qué vas a tener

- Un servidor chico en la nube (tu computadora puede estar apagada) con: el servidor de J.A.R.V.IS, el worker de recordatorios, Caddy para HTTPS y backups cifrados fuera del servidor.
- Claude corre en Anthropic con tu suscripción. El servidor solo ejecuta el programa oficial Claude Code, sin modificar.
- Una app web instalable (PWA) que es solamente una conversación, por texto y por voz.

## 1. Probarlo en tu computadora (sin gastar nada)

```bash
nvm use 24
pnpm install
cd apps/server && printf "OWNER_PASSWORD_HASH='%s'\n" "$(pnpm -s hash-password)" >> ../../.env && cd ../..
pnpm --filter @jarvis/web build
RUNTIME=scripted WEB_DIST_DIR=../web/dist DATA_DIR=../../data pnpm --filter @jarvis/server dev
```

Las rutas son relativas a `apps/server`, donde corre el servidor de desarrollo. Abrí `http://localhost:8080` y entrá con tu contraseña. `RUNTIME=scripted` usa respuestas de prueba; sacalo para hablar con Claude usando tu sesión local de Claude Code.

## 2. Lo que tenés que decidir o crear vos

| Paso | Por qué | Costo |
| - | - | - |
| Servidor (VPS) | Donde corre todo | ver [costs.md](costs.md) |
| Dominio | HTTPS y notificaciones en iPhone lo necesitan | ~USD 11/año |
| Bucket B2 o R2 | Backups cifrados fuera del servidor | centavos/mes |
| `claude setup-token` | Token de tu suscripción para el servidor | incluido en tu plan |
| Proyecto de Google Cloud + OAuth | Leer Gmail (solo lectura) | gratis |
| Clave de Groq (opcional) | Transcribir tu voz | ~USD 0.03–0.20/mes |
| Clave de ElevenLabs (opcional) | Voz de calidad o clonada | según plan |
| Clave de YouTube Data API (opcional) | Buscar videos | gratis con cuota |

Nunca pegues contraseñas, tokens ni claves en el chat. Van solamente a los archivos de entorno del servidor.

## 3. Preparar el servidor

Seguí [deploy.md § 2](deploy.md#2-prepare-the-host): usuario sin root, SSH solo con llave, firewall con 22/80/443, actualizaciones automáticas y Docker.

## 4. Secretos

Generalos en tu computadora, no en el servidor:

```bash
cd apps/server
pnpm -s hash-password            # hash de la contraseña del dueño
pnpm -s vapid:generate           # claves de notificaciones push
openssl rand -base64 32          # TOKEN_ENCRYPTION_KEY
claude setup-token               # CLAUDE_CODE_OAUTH_TOKEN (login en el navegador)
```

Copialos a `/etc/jarvis/jarvis.env` y `/etc/jarvis/backup.env` en el servidor (permisos 600), como muestra [deploy.md § 3](deploy.md#3-code-and-secrets). Guardá `TOKEN_ENCRYPTION_KEY` y la contraseña de restic en tu gestor de contraseñas: sin ellas no se pueden leer los backups ni las cuentas conectadas.

## 5. Desplegar

```bash
cd /opt/jarvis
infra/scripts/deploy.sh "$(git rev-parse --short HEAD)"
curl -fsS https://TU-DOMINIO/healthz
```

`deploy.sh rollback` vuelve a la versión anterior. Antes de cada actualización se hace un backup.

## 6. Instalar en el celular

1. Abrí `https://TU-DOMINIO` y entrá con tu contraseña.
2. iPhone: Compartir → Agregar a inicio. Las notificaciones solo funcionan con la app instalada.
3. Desde la app instalada, tocá la tarjeta de notificaciones para darles permiso.

## 7. Conectar cuentas

- Gmail personal: pedile a J.A.R.V.IS "conectá mi Gmail" o abrí `/api/integrations/google/start?label=personal`. Detalles y la expiración de tokens en modo Testing: [integrations/gmail.md](integrations/gmail.md).
- WhatsApp: importá chats exportados con `pnpm --filter @jarvis/server wa:import <archivo> --chat "Nombre"`, o activá el bridge (`WHATSAPP_ENABLED=true`, perfil `whatsapp`) y escaneá el QR desde la tarjeta del chat. Leé antes los riesgos en [integrations/whatsapp.md](integrations/whatsapp.md).
- Voz: configurá `STT_PROVIDER` y `TTS_PROVIDER` como explica [voice.md](voice.md).

## Si algo falla

- "Se agotó la cuota de Claude": esperá al reinicio; los recordatorios siguen funcionando.
- "No pude autenticarme con Claude": corré otra vez `claude setup-token` y actualizá el token.
- Restaurar un backup, rotar secretos o revocar accesos: [runbook.md](runbook.md).
