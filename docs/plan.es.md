# Replanteo de J.A.R.V.IS (2026-11-20, ajustado el 2026-11-21)

J.A.R.V.IS pasa a tener dos objetivos desde el principio:

1. Asistente personal.
2. Punto de control de tareas laborales que hacen agentes en segundo plano.

Es una sola conversación, un solo backend y un solo box. El diseño técnico está en [agents.md](agents.md); la arquitectura general, en [architecture.md](architecture.md).

## Decisión principal

**JARVIS es la interfaz; el orquestador es software, no otro modelo.**

- **JARVIS en el chat (Sonnet, tu suscripción)** responde rápido las consultas. Cuando hay que ejecutar trabajo, registra una tarea y te confirma que quedó en cola.
- **Un ejecutor de tareas, en un contenedor aparte del mismo box**, la lleva por plan, ejecución y revisión. Planificador, ejecutor y revisor son sesiones separadas del Agent SDK: Haiku planifica, Sonnet ejecuta y revisa, y Haiku explora. La cola, los límites, los reintentos, la recuperación y los avisos los maneja código.
- **El revisor contrasta el trabajo con el pedido original y los criterios.** Recibe el diff que mide el sistema; no le alcanza el resumen del ejecutor.
- **Ningún agente puede publicar, desplegar ni enviar nada.** Si hace falta, lo pide como aprobación y vos la tocás en la tarjeta.

## Qué cambia respecto del plan anterior

| Componente | Decisión | Motivo |
| --- | --- | --- |
| Runtime de Claude para el chat (Agent SDK, tu suscripción, MCP propio) | Se mantiene | Validado con el servicio real. Ahora suma las herramientas `task_*`. |
| PWA conversacional | Se modifica | Tarjeta de tarea con estado, revisión, entregables y botones; adjuntar archivos y capturas. Sin dashboard. |
| Memoria, agenda, acuerdos, recordatorios, outbox, Web Push | Se mantiene | El worker suma los avisos de tareas por el mismo outbox. |
| Gmail (personal y laboral, solo lectura), WhatsApp (puente opcional), YouTube | Se mantiene | Siguen del lado personal. Los agentes no las ven. |
| Voz (Groq + ElevenLabs) | Se mantiene | No hace falta para probar las tareas por texto. |
| Orquestación de tareas laborales (cola, runner, ejecutor/revisor, aprobaciones, avisos) | Nuevo | Es el segundo objetivo. |
| Base `work.db` y volumen de trabajo separados | Nuevo | Separa lo personal de lo laboral en disco, no solo en el prompt. |
| Plan Claude Pro (USD 20) | Se reemplaza por Max (USD 100) | Chat y agentes van por tu suscripción, con tokens separados y sin API. Max da 5 veces el uso de Pro. Los agentes dejan arrancar fases nuevas al 70 % de cualquier ventana del plan, para que al chat le quede margen. Ver [claude-runtime.md](claude-runtime.md#chosen-mode-owner-decision-2026-11-21). |
| Servidor Lightsail São Paulo 2 GB (USD 12) | Se modifica a 4 GB (USD 24) | Los agentes corren Claude Code, pruebas y builds en el mismo box. 2 GB no alcanza. |
| Sistema operativo del VPS | Se modifica: preferir Debian 13 | En Ubuntu, AppArmor bloquea el sandbox de Bash de los agentes (medido acá). Hay que confirmarlo en el VPS. |
| Docker Compose, Caddy, backups a R2 | Se modifica | Servicio `agent-runner` (perfil `agents`), volumen `work-data` y backup de `work.db`. |
| Dominio `jarvis.lminervino18.com`, Groq, ElevenLabs, R2, healthchecks | Se mantiene | Sin cambios. |
| Fase 1: alarmas, timers y llamadas con Atajos de iPhone | Se posterga | Primero el flujo de tareas. El diseño sigue vigente. |
| Fase 2: avisos de WhatsApp por reglas | Se posterga | Igual que arriba. |
| Fase 3: Instagram con la API oficial (y la cuenta de Meta for Developers) | Se posterga | Igual que arriba. |
| Firmware ATOM Echo | Se reemplaza | El terminal de voz es la ReSpeaker XVF3800 en la carcasa ARC (rama `feat/arc-enclosure`). El firmware nuevo espera al hardware. |
| Terminal de voz ReSpeaker + carcasa ARC | Se posterga | Se integra sobre este mismo backend. No es requisito para probar. |
| Perfil de voz local (Whisper/Piper) en el box | Se posterga | Con agentes en el mismo box pediría la clase de 8 GB. |
| Conector con la app de la empresa | Se posterga | No se inventa una API. Queda la interfaz `source`/`external_ref`, idempotente. |
| Se elimina | Nada del código | Se descartaron alternativas: un LLM orquestador intermedio, una sesión eterna, la API key con los créditos de Max (decisión tuya: nada de API), OpenRouter, Managed Agents (por ahora) y MCPs de terceros para los agentes. |

## Qué corre en el box y qué depende de terceros

| En el box (un VPS, Docker Compose) | Proveedores externos |
| --- | --- |
| Caddy (TLS) | Anthropic: chat y agentes por tu suscripción |
| Servidor: API, WebSocket, PWA, herramientas, voz | Groq (STT) y ElevenLabs (TTS) |
| Worker: recordatorios, outbox, push, avisos de tareas | Servicios de push del navegador (Apple, Google) |
| Ejecutor de agentes: un contenedor sin datos personales | Cloudflare R2 (backups cifrados) |
| `jarvis.db` y `work.db` (SQLite) y los espacios de trabajo por tarea | Google (Gmail) y WhatsApp, si los conectás |
| Backup con restic | |

La única excepción prevista es la red de la empresa. Si sus sistemas exigen VPN, otro sistema operativo u otra red, ese conector va aparte. Se decide cuando se conozcan los accesos.

## Costo mensual

Precios del 2026-11-20, antes de impuestos argentinos. El detalle está en [costs.md](costs.md).

| Concepto | USD/mes |
| --- | --- |
| Lightsail São Paulo 4 GB | 24 |
| Voz, de 10 a 60 pedidos por día | 2 a 13 |
| R2 y dominio | 0 |
| Claude Max | 100 |
| **Total** | **≈ 126 a 137** |

- La alternativa barata es Hetzner CX33 (EUR 8,99, en Europa, con disponibilidad incierta): cerca de USD 14 menos, con más latencia en el chat y la voz.
- Los agentes no suman costo fuera de Max: consumen uso del plan, no plata. El uso extra pago tiene que seguir desactivado en tu cuenta.
- La tarea controlada consumió unos USD 0,11 de uso estimado. Cuántas tareas reales entran por semana se sabe midiendo el uso del plan que registra cada sesión.
- Pro alcanza para empezar a medir: la reserva protege al chat, pero los agentes se van a pausar mucho más seguido.

## Fases nuevas

0. **Poner en marcha:**
   - VPS de 4 GB, preferentemente con Debian 13;
   - Max, y un token de suscripción solo para agentes (`claude setup-token`) en `/etc/jarvis/agents.env`;
   - desactivar el uso de tus datos para entrenar modelos en la privacidad de claude.ai, y confirmar que la empresa permite procesar su material con Claude;
   - `COMPOSE_PROFILES=agents`;
   - verificar el sandbox de Bash en el VPS;
   - repetir la prueba controlada con Claude real y Bash.
1. **Primeras tareas reales cargadas a mano**, con texto, archivos y capturas:
   - medir uso del plan (`task_runs.plan_utilization`), tiempo y calidad;
   - ajustar los límites;
   - escribir `projects/<slug>/CONTEXT.md` por cada sistema de la empresa a medida que tengas accesos.
2. **Conector con la app de la empresa**, cuando conozcamos su API o mecanismo autorizado. Las acciones externas aprobadas las ejecuta código determinístico, nunca el agente.
3. **Lo postergado del teléfono**: Atajos, avisos de WhatsApp e Instagram.
4. **Terminal de voz** ReSpeaker + carcasa ARC.

## Supuestos reversibles que tomé

- Las tareas son laborales y de una sola empresa por ahora. El campo `project` alcanza para separar sistemas.
- Presupuesto por tarea de USD 5, concurrencia 1 y 2 rondas automáticas de corrección. Son variables de entorno.
- Los avisos push solo dicen el número de la tarea. El detalle se ve en el chat, con sesión iniciada.
- Las entregas quedan en el box y las bajás desde la tarjeta. Los espacios de trabajo no entran al backup; `work.db` sí.
