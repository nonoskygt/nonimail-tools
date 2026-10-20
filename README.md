# NoniMail Cleaner

Limpia tu bandeja de entrada con una IA que corre en tu propio equipo. Hay app para **Windows**, para
**Android** y versión de navegador (`npm start`). Se conecta a tu correo por **IMAP** (Gmail, Yahoo,
iCloud, Zoho o cualquier servidor) y mueve a la Papelera solo lo claramente promocional.

Ningún asunto ni cuerpo de correo sale hacia un servicio externo de IA.

## Instalar

| Plataforma | Archivo | Requisitos |
|---|---|---|
| Windows 10/11 (64 bits) | `NoniMail-Cleaner-Setup-3.0.0.exe` | 4 GB de RAM como mínimo; el instalador lo comprueba |
| Android 8 o más nuevo (arm64) | `NoniMail-Cleaner-3.0.0.apk` | 4 GB de RAM; probado para Snapdragon 8 Gen 3 (Red Magic 9 Pro) |

- **Windows:** el instalador es de un clic, no pide permisos de administrador y crea el ícono en el
  escritorio y en el menú Inicio. Como no está firmado, SmartScreen avisa: **Más información → Ejecutar de
  todas formas**.
- **Android:** habilita "Instalar apps desconocidas" para el navegador o el gestor de archivos y abre el APK.

La primera vez la app pide dos cosas: **conectar tu correo** y **descargar la IA**. La descarga se hace una
sola vez, se retoma sola si se corta internet y se verifica con SHA-256.

## La IA local

Corre con [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`) incluido en la app. El modelo
se elige según la RAM del equipo:

| RAM | Modelo | Descarga | Por remitente (CPU) |
|---|---|---|---|
| 4 a 7 GB | Qwen 3.5 · 0.8B (Q4_K_M) | 508 MB | ~0,5 s |
| 8 GB o más | **Qwen 3.5 · 2B (Q4_K_M)**, recomendado | 1,2 GB | ~1 s |
| 16 GB o más (a elección) | Qwen 3.5 · 4B (Q4_K_M) | 2,6 GB | más lento |

Medido con `scripts/bench-llm.js`, sobre 40 correos de ejemplo en español e inglés, en el CPU de un equipo
de escritorio:
- **El 2B acertó 33 de 34 y no dejó ningún correo importante para borrar.**
- El 0.8B es más rápido, pero llegó a darle 100 a una cita y a un recibo. Por eso solo se usa cuando no
  entra el 2B.

**Por qué es rápido.** Qwen 3.5 es un modelo híbrido: llama.cpp solo reutiliza el prompt desde un
checkpoint. Por eso la parte fija (las instrucciones) se procesa una vez y cada correo procesa solo lo suyo,
lo que lo vuelve unas 5 veces más rápido. El motor se apaga solo tras 10 minutos sin trabajo para liberar RAM.

**Ollama.** Sigue disponible en **Ajustes → IA → Avanzado → Motor**.

## Cómo se usa

1. Elige cuánto revisar (7 días a "Todo") y la intensidad: **Suave**, **Normal** o **A fondo**.
2. **Analizar bandeja**: lee los correos, los agrupa por remitente y los puntúa. No borra nada.
3. Revisa las tres pestañas (**Borrar**, **En duda**, **Se quedan**) y corrige lo que quieras con ✓ o 🗑.
   Lo que corrijas queda guardado para siempre.
4. **Mover a la papelera.** La campana tachada da de baja de esa lista (one-click RFC 8058, correo o enlace).

**Limpiar sin revisar** hace todo de una vez y borra solo lo claramente promocional. **Solo simular** muestra
lo que haría sin tocar el buzón.

**Progreso.** La barra avanza por correos reales: muestra el porcentaje, cuántos van de cuántos, el
remitente que se revisa y el tiempo restante. En Windows también se ve en la barra de tareas y en Android
en la notificación. Si paras, se corta internet o cierras la app, aparece **Continuar** y sigue desde donde
quedó.

### Lo que nunca se borra

- Bancos, facturas, recibos, pagos, códigos 2FA y alertas de seguridad (regex de protección, en **Ajustes → Reglas**).
- Tus reglas por remitente.
- Conversaciones: respuestas e hilos donde escribiste.
- Lo que queda "En duda".

Borrar es **mover a la Papelera** (recuperable). Si no se encuentra la Papelera o el servidor no soporta
MOVE/UIDPLUS, la app no borra nada. Los correos no se marcan como leídos.

## Conectar el correo

- **Gmail · Contraseña de app (lo más fácil):** requiere la verificación en 2 pasos. Créala en
  <https://myaccount.google.com/apppasswords> y pégala.
- **Gmail · Cuenta de Google:** usa tu propio cliente OAuth. Hay que habilitar la Gmail API y crear un
  "ID de cliente → App de escritorio" en Google Cloud Console. Los pasos están en la app.
- **Yahoo / iCloud:** contraseña de aplicación de esa cuenta.
- **Otro:** servidor IMAP (y SMTP para las bajas por correo).

Outlook/Hotmail no está soportado porque Microsoft ya no acepta contraseñas por IMAP.

## Arquitectura

```
public/            interfaz (HTML + CSS con tokens + JS, sin build)
server.js          servidor local 127.0.0.1 + SSE; start({ port }) lo usan Windows y Android
lib/engine.js      trabajos por lotes de fecha, con progreso guardado
lib/llm.js         puntaje 0-100 (IA integrada u Ollama)
lib/runtime.js     IA integrada: descarga del modelo y proceso llama-server
lib/models.js      catálogo de modelos (URL fija a un commit + sha256)
desktop/           app de Windows (Electron) e instalador (build/installer.nsh: chequeo de RAM)
android/           app de Android: WebView + Node.js (nodejs-mobile) + llama-server arm64
```

Es el mismo motor en todas las plataformas. En Android, Node corre dentro de la app en un servicio en primer
plano: la limpieza sigue con la pantalla apagada y el avance se ve en la notificación.

## Compilar

```bash
npm install
npm test                 # 55 pruebas con IMAP/SMTP en memoria; no tocan ningún buzón real
npm start                # versión navegador en http://localhost:8765
npm run app              # app de escritorio sin empaquetar
npm run dist:win         # → dist/NoniMail-Cleaner-Setup-3.0.0.exe
```

**Android:** requiere el Android SDK (platform 35, build-tools 35, NDK 27.2, CMake 3.22.1) y JDK 17.

```bash
node scripts/fetch-llama.js android-arm64
# bajar nodejs-mobile-v18.20.4-android.zip a vendor/.dl/ (la URL está en scripts/android-prepare.js)
npm run android:prepare
cd android && gradlew assembleRelease   # → app/build/outputs/apk/release/app-release.apk
```

La firma usa `android/keystore.properties`, que no se versiona. Sin ese archivo, el APK se firma con la clave
de depuración. **Respalda `android/keystore/`:** sin esa clave no se puede publicar una actualización que se
instale encima de la anterior.

**Otras herramientas:**
- `node scripts/demo-imap.js` levanta un buzón de prueba con 154 correos sintéticos (testuser / testpass).
- `node scripts/bench-llm.js <modelo>` mide un modelo.

## Datos locales

| Plataforma | Carpeta |
|---|---|
| Windows | `%APPDATA%\NoniMail Cleaner` |
| Android | memoria interna de la app |
| `npm start` | la carpeta del proyecto, o `NONIMAIL_DATA_DIR` |

En esa carpeta están `config.json`, `secrets.json` (contraseña o token: **no lo compartas**),
`senders.json`, `progress.json`, `logs/` y `models/`.

## Seguridad

- El servidor escucha solo en `127.0.0.1`. Rechaza un `Host` ajeno (DNS rebinding) y los POST de otro origen
  (CSRF).
- En las apps de Windows y Android, el servidor exige además un token secreto que se genera en cada arranque.
  La ventana lo manda como cookie HttpOnly. Así ninguna otra app del celular o de la PC puede usar la API.
  `npm start`, en el navegador, no usa token.
- La API nunca devuelve secretos.
- Los enlaces de baja solo se abren si son `https` y nunca hacia la red local.
- La app de escritorio usa `contextIsolation` y `sandbox`. Los enlaces externos se abren en el navegador del
  sistema.

## Licencia

El código propio no lleva licencia declarada: todos los derechos reservados. Los componentes de terceros
están en [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

