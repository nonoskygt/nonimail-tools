# Licencias de terceros

## Incluidos en el repositorio

| Componente | Uso | Licencia |
|---|---|---|
| [Inter](https://rsms.me/inter/) (vía @fontsource-variable/inter 5.3.0) | Tipografía de la interfaz, `public/assets/fonts/` | SIL Open Font License 1.1 (`Inter-OFL.txt`) |
| [Lucide](https://lucide.dev) | Trazos de íconos en `public/index.html` | ISC |

## Incluidos en las apps empaquetadas (no versionados; los bajan los scripts)

| Componente | Uso | Licencia |
|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) b11748 | Motor de IA (`llama-server`), Windows y Android | MIT |
| [Electron](https://www.electronjs.org) 44 | App de escritorio | MIT (Chromium y Node.js con sus propias licencias) |
| [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) 18.20.4 | Node.js dentro de la app de Android | MIT y las licencias de Node.js |

## Descargados por la app

| Modelo | Uso | Licencia |
|---|---|---|
| [Qwen 3.5](https://huggingface.co/Qwen/Qwen3.5-2B) 0.8B / 2B / 4B, GGUF de [Unsloth](https://huggingface.co/unsloth) | Clasificación de correos | Apache-2.0 |

## Dependencias de npm

| Paquete | Uso | Licencia |
|---|---|---|
| [imapflow](https://github.com/postalsys/imapflow) | Cliente IMAP | MIT |
| [nodemailer](https://github.com/nodemailer/nodemailer) | Envío SMTP de bajas por correo | MIT-0 |
| [electron-builder](https://www.electron.build) (desarrollo) | Instalador de Windows | MIT |
| [sharp](https://sharp.pixelplumbing.com) y [png-to-ico](https://github.com/steambap/png-to-ico) (desarrollo) | Íconos | Apache-2.0 / MIT |
| [hoodiecrow-imap](https://github.com/andris9/hoodiecrow) (solo pruebas) | Servidor IMAP en memoria | MIT |
| [smtp-server](https://github.com/nodemailer/smtp-server) (solo pruebas) | Servidor SMTP local | MIT-0 |

Las dependencias transitivas de producción (libmime, libqp, libbase64, iconv-lite, pino, etc.) son MIT o ISC.

Hasta la versión 1.x, el repositorio incluía `gmail_bridge.example.gs`, derivado del Gmail Bridge de
[AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) (Mintplex Labs Inc., MIT). La versión 2.0 lo eliminó.
