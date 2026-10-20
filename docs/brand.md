# NoniMail Cleaner: marca y sistema de diseño

> v1.0 · 2026-10-19 · Fuente de verdad de los tokens: `public/assets/app.css`

## Las 7 skills de diseño y lo que produjo cada una

| Skill | Qué aportó | Dónde quedó |
|---|---|---|
| **ui-ux-pro-max** | Sistema de diseño recomendado para una utilidad de correo (Minimalismo suizo, azul de bandeja + rojo de prioridad), reglas de accesibilidad, táctil y progreso (objetivos de 44 px, contraste 4,5:1, `prefers-reduced-motion`, una sola acción principal por pantalla) | Toda la interfaz: `public/index.html`, `public/assets/app.css`, `public/assets/app.js` |
| **brand** | Voz (directa, breve, para todo el mundo y sin jerga) y la regla de quitar textos explicativos | Sección "Voz" de este archivo; textos de la interfaz |
| **design-system** | Tokens en tres capas: primitivo → semántico → componente, en claro y oscuro | `:root` de `public/assets/app.css` y la tabla "Color" de este archivo |
| **ui-styling** | Componentes al estilo shadcn en CSS sin dependencias: botones, chips, segmentado, interruptor, barra de progreso, hoja lateral, diálogo y toasts | `public/assets/app.css` (sección de componentes) |
| **design** | Brief de logo (fresco, limpio, con destello) e ícono vectorial legible de 16 a 512 px | `public/assets/icon.svg` → `build/icon.ico`, mipmaps e ícono adaptativo de Android (`scripts/make-icons.js`) |
| **banner-design** | Gráfico de presentación minimalista de 1024×500 para la página de descarga o la tienda | `build/feature-graphic.svg` / `.png` |
| **slides** | Guía rápida de 4 diapositivas para aprender a usar la app, con los mismos tokens | `docs/guia-rapida.html` |

## Voz

| Rasgo | Sí | No |
|---|---|---|
| **Directa**: el verbo primero | "Analizar bandeja", "Mover 99 correos a la papelera" | "Haz clic aquí para comenzar el proceso de análisis" |
| **Breve**: sin explicar lo obvio | "Solo simular" | "Activa esta opción si deseas ver qué pasaría sin…" |
| **Tranquilizadora**: nunca alarmista | "Lo que ya está en la papelera se queda ahí." | "¡ATENCIÓN! Acción irreversible" |
| **Para todo el mundo**: tú y sin jerga | "IA local", "Se quedan" | "LLM", "dureza", "dry-run", "heurísticas" |

Los textos de ayuda solo aparecen donde evitan un error: una contraseña de aplicación o una confirmación
antes de mover a la papelera.

## Color

Los colores se definen en tres capas: **primitivos → semánticos → componentes**. Los componentes solo usan
semánticos.

| Rol | Claro | Oscuro | Uso |
|---|---|---|---|
| `--primary` | `#2563EB` | `#2563EB` | Acción principal, selección, progreso |
| `--danger` | `#DC2626` | `#DC2626` (texto `#FCA5A5`) | Borrar / mover a la papelera |
| `--ok-text` | `#15803D` | `#86EFAC` | "Se quedan", éxito |
| `--warn-text` | `#B45309` | `#FCD34D` | "En duda", avisos |
| `--bg` / `--surface` | `#F8FAFC` / `#FFFFFF` | `#0A1020` / `#0F172A` | Fondo / tarjetas |
| Acento del ícono | `#6EE7B7` | — | Solo en el destello del logo |

Todo texto normal cumple 4,5:1 en los dos temas. El color nunca es la única señal: cada estado lleva además
un ícono o una palabra.

## Tipografía

- **Inter variable**, incluida en la app; funciona sin internet.
- Escala: 12 · 14 · 16 · 18 · 22 · 30 · 44 px. El texto de lectura usa 16 px con interlineado 1,5.
- Las cifras usan `tabular-nums` para que no salten mientras avanza el progreso.

## Ícono

- Sobre blanco sobre un cuadrado azul redondeado (radio 116/512), con un destello menta: correo limpio.
- Archivos:
  - `public/assets/icon.svg`
  - `build/icon.ico`, de 16 a 256 px
  - Ícono adaptativo de Android: `android/.../ic_launcher_foreground.xml`
- Regenerar todo con `npm run icons`.

## Componentes

| Componente | Estados |
|---|---|
| Botón primario / peligro / secundario / fantasma | hover, pressed (escala 0,98), deshabilitado (45 %), foco (anillo de 3 px) |
| Chip de rango, segmentado, interruptor | `aria-checked` |
| Barra de progreso | determinada (ancho) o indeterminada (mientras carga la IA o conecta) |
| Fila de remitente | avatar con inicial, conteo, puntaje como etiqueta, baja (campana), ✓ / 🗑 |
| Hoja de ajustes | lateral en escritorio, pantalla completa en el celular; cierra con Esc o Atrás |

Táctil: objetivos de 40 a 44 px como mínimo. Movimiento: de 120 a 320 ms y respeta
`prefers-reduced-motion`. Disposición: una columna en el celular; en 1000 px o más, controles a la izquierda
y resultados a la derecha.
