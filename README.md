# Sistema de Control y Aprobación de Horas Extra

Sistema para que los **supervisores** carguen sus horas extra y días de compensación, y el **Jefe de Fraccionamiento** los apruebe desde el mismo correo o desde una WebApp propia, con notificación automática y acumulación de saldo.

**Contexto:** VSPT Wine Group — Planta Graffigna, San Juan, Argentina. Área de Fraccionamiento (~50 personas, 3 líneas L1/L2/L3).

**Estado:** script refactorizado (directorio de correos en hoja aparte, saldo validado, concurrencia con lock). Prototipo visual de la WebApp disponible en [`prototipo/prototipo.html`](prototipo/prototipo.html) para aprobación de diseño. Ver también [`docs/HANDOFF_ControlHorasExtra.md`](docs/HANDOFF_ControlHorasExtra.md) (contexto histórico del diseño original).

---

## Funcionalidades

- Carga de horas extra por parte del supervisor (Google Form, y a futuro desde la WebApp propia).
- Notificación al correo del jefe con botones **APROBAR / RECHAZAR** (link con token único, sin abrir la planilla).
- Acumulación del saldo de horas aprobadas por supervisor.
- Segundo flujo: solicitud de **días de compensación** contra ese saldo, con la misma aprobación. El saldo insuficiente se **bloquea** automáticamente (no llega a quedar Pendiente).
- Copia informativa a RRHH / Gestión de Personas.
- **Resumen mensual** automático enviado al jefe (día 1, 07:00).
- Directorio de correos y roles administrable desde una hoja propia (`Correos`), sin tocar el código.
- Vista de solo lectura para **RRHH / Gestión de Personas** en el prototipo de la WebApp: saldos de todo el equipo, sin botones de aprobación ni edición.

## Arquitectura

| Capa | Tecnología |
|---|---|
| Base de datos | Google Sheet `DB_HorasExtra` |
| Ingreso de datos | Google Forms (2: horas extra y compensación) |
| Lógica y notificaciones | Google Apps Script ([`ControlHorasExtra.gs`](ControlHorasExtra.gs)) |
| Aprobación | Botón en el mail → WebApp (`doGet`) con token |
| Frontend | **WebApp propia** sobre Apps Script (`HtmlService`), servida por el mismo script — reemplaza la idea original de usar AppSheet. Ver el prototipo visual en `prototipo/prototipo.html`. |

## Modelo de datos (`DB_HorasExtra`)

**Hoja `Solicitudes`**

`ID | Timestamp | Supervisor | Email | Fecha HE | Horas | Linea | Motivo | Estado | Aprobado por | Fecha aprobacion | Comentario | Token`

**Hoja `Compensaciones`**

`ID | Timestamp | Supervisor | Email | Fecha solicitada | Horas a compensar | Tipo | Estado | Aprobado por | Fecha aprobacion | Comentario | Token`

**Hoja `Auditoria`**

`Timestamp | ID | Accion | Usuario | Detalle`

**Hoja `Correos`** (directorio de personas — reemplaza a `CONFIG.JEFE_EMAIL` / `CONFIG.RRHH_EMAILS`)

`Email | Nombre | Rol | Activo`

- `Rol`: `Supervisor` | `Jefe` | `RRHH` (con validación de datos en la celda).
- `Activo`: `SI` | `NO` (con validación de datos en la celda).
- **Sin columna `Linea`**: un supervisor puede cubrir más de una línea, así que no tiene sentido atarle una fija en el directorio. La línea se elige en cada carga, en la hoja `Solicitudes` (columna `Linea` de esa hoja, sin cambios).
- Tiene que haber **al menos un Jefe activo** cargado para que el sistema pueda notificar y aprobar. El rol `RRHH` solo da acceso de **lectura** (copia informativa de mails y, en el prototipo, la vista de consulta) — no aprueba ni edita nada.
- El script lee esta hoja a través de `_directorio()`, con cache de 5 minutos (`CacheService`). Si editás la hoja y necesitás que el cambio se vea al toque, corré manualmente `invalidarCacheDirectorio()` desde el editor de Apps Script.
- `setup()` deja una fila de ejemplo con `Activo = NO` y el email `REEMPLAZAR@invalid` (dominio `.invalid`, reservado por RFC 2606: nunca resuelve ni recibe correo real). Reemplazá esa fila por el Jefe real y poné `Activo = SI`. `jefeEmail()` rechaza explícitamente cualquier correo con dominio `.invalid` o `.example`, así que el sistema no puede quedar "funcionando" con el placeholder puesto por error.

> **IMPORTANTE — privacidad:** los correos reales de la empresa **no van en el repositorio ni en el código**, en ningún archivo, comentario o dato de ejemplo. Se cargan a mano en la hoja `Correos` del Google Sheet, que vive solo en la cuenta de Google Workspace de la empresa. Cualquier ejemplo en el código o la documentación usa placeholders (`@ejemplo.com`) y nombres genéricos.

Convenciones:
- `ID`: prefijo `HE-` o `CP-` + `yyMMdd-HHmmss`. El prefijo enruta en `doGet`.
- `Estado`: `Pendiente` | `Aprobada` | `Rechazada`.
- `Token`: UUID, siempre en la última columna.
- **Saldo** = Σ `Horas` aprobadas (`Solicitudes`) − Σ `Horas a compensar` aprobadas (`Compensaciones`), por `Email`. Fuente de verdad: `saldoSupervisor(email)` y `validarCompensacion(email, horas)`.

## Instalación

1. Crear un Google Sheet llamado `DB_HorasExtra`.
2. **Extensiones → Apps Script** y pegar [`ControlHorasExtra.gs`](ControlHorasExtra.gs).
3. Ejecutar `setup()` una vez (crea las 4 hojas con encabezados: `Solicitudes`, `Compensaciones`, `Auditoria`, `Correos`).
4. Completar la hoja `Correos` con los correos y roles reales del equipo (al menos un `Jefe` activo). Los correos **no se cargan en el código**.
5. Crear los 2 Google Forms y vincular sus respuestas a este Sheet. Las hojas destino deben contener `HE` o `COMP` en el nombre (así rutea `onFormSubmitHE`).
6. **Implementar → Nueva implementación → Aplicación web** con *Ejecutar como: YO* y *Acceso: Cualquier usuario*. Copiar la URL a `CONFIG.WEBAPP_URL`.
7. Activadores:
   - `onFormSubmitHE` → *Desde hoja de cálculo / Al enviar formulario*.
   - `resumenMensual` → *Basado en tiempo / Mensual, día 1, 07:00*.

## Configuración (`CONFIG` en el `.gs`)

| Clave | Descripción |
|---|---|
| `WEBAPP_URL` | URL de la WebApp (se obtiene tras implementar) |
| `NOMBRE_PLANTA` | Nombre que aparece en mails y resúmenes |
| `HORAS_POR_DIA` | Equivalencia día → horas para compensación (8) |
| `TZ` | `America/Argentina/San_Juan` |

Los correos del jefe y de RRHH **ya no están en `CONFIG`**: se leen dinámicamente de la hoja `Correos` mediante `jefeEmail()` y `rrhhEmails()`.

## Prototipo visual (`prototipo/prototipo.html`)

Maqueta navegable, autocontenida (sin CDNs ni dependencias externas), con datos mock, pensada para aprobar el diseño de la futura WebApp antes de programarla. Se abre directamente en el navegador.

Incluye selector de rol (Supervisor / Jefe / RRHH), las tres vistas completas (la de RRHH es de solo lectura), modales de carga y compensación, animaciones de éxito/aprobación, y modo claro/oscuro.

### Sistema de diseño

Sigue el **manual de diseño oficial de VSPT** (no es una paleta inventada). Tipografía y color son de uso obligatorio tal como están documentados acá; no se agregan variaciones.

**Tipografía — Montserrat, única familia del sistema.** Se embebe como `@font-face` con el archivo variable en data URI (pesos 100-900) porque el prototipo no puede depender de una CDN de fuentes. En la WebApp real de Apps Script se puede reemplazar por el `<link>` de Google Fonts.

| Rol | Tamaño | Peso | Notas |
|---|---|---|---|
| Display | 48-64px | 800 | tracking -1px, line-height 1 |
| H1 | 32-40px | 800 | tracking -0.5px |
| H2 | 24-28px | 700 | tracking -0.3px |
| H3 | 18-20px | 700 | tracking 0 |
| Eyebrow | 9-11px | 700 | MAYÚSCULA, tracking 0.16-0.22em (firma editorial) |
| Body | 14-16px | 400 | line-height 1.5-1.65 |
| Body small | 12-13px | 400 | line-height 1.5 |
| Caption | 11-12px | 400-500 | color muted |
| Numérico KPI | 32-48px | 800 | tabular-nums, tracking -1px |

El prototipo usa solo 3 pesos en toda la página (400, 700, 800) para cumplir la regla del manual de no mezclar más de tres. Números alineables siempre con `font-variant-numeric: tabular-nums`.

**Paleta maestra** (únicos colores permitidos):

| Token | Valor | Uso |
|---|---|---|
| `--vspt-plum` | `#4E1742` | Texto principal en claro, headers institucionales |
| `--vspt-deep-purple` | `#321032` | Refuerzo de plum, gradientes |
| `--vspt-wine` | `#701F52` | Acento primario, barras y bordes destacados |
| `--vspt-crimson` | `#D81840` | Alerta crítica, valores negativos, error — **reservado**, nunca decorativo |
| `--vspt-amber` | `#F8C040` | Atención, highlight de KPI, foco |
| `--vspt-orange` | `#F08808` | Estado intermedio, borde de card neutro destacado |
| `--vspt-olive` | `#98A040` | Estado positivo / OK — **reservado**, no es un verde decorativo |
| `--vspt-cream` | `#F5EBD3` | Fondo secundario, zebra |
| `--vspt-beige` | `#E0D0B8` | Bordes sutiles |
| `--vspt-beige-soft` | `#FAF5E8` | Fondo principal en claro |
| `--vspt-magenta` | `#B61858` | Variante de crimson para gradientes |

Semáforo de estado: `olive` = Aprobada, `amber` = Pendiente, `crimson` = Rechazada. El color nunca es el único indicador — todo chip de estado combina color + ícono + texto.

Gradientes — son los **únicos 4** permitidos, no se inventan otros:
- Header institucional: `linear-gradient(135deg,#4E1742 0%,#321032 55%,#701F52 100%)`
- Acento dorado (barra de título): `linear-gradient(180deg,#F8C040,#F08808)`
- CTA principal: `linear-gradient(135deg,#321032,#D81840)`
- KPI crítico (border-top de card alertable): `linear-gradient(90deg,#D81840,#701F52,#4E1742)`

**Superficies y componentes:** fondo institucional muy oscurecido solo en modo oscuro (en claro, plano y sin gradientes); tarjetas con `background` semitransparente (~90% opacidad) + `backdrop-filter: blur(14px) saturate(120%)` — sombra chica y sobria, sin inset brillante ni glow; radios 12px en tarjetas, 7-8px en botones/inputs, hasta 16px en modales; border-top de 3px como firma visual del tipo de tarjeta (crimson=alerta, amber=atención, olive=OK, orange=neutro destacado); botones en mayúscula con tracking 0.16-0.18em; foco visible con outline 2px (amber en oscuro; una variante más oscura de amber en claro, ver nota de contraste abajo); transición de tema `background .3s, color .3s`; blobs de fondo solo en oscuro, en wine/plum, opacidad ~0.20; mobile-first (390px) con áreas táctiles ≥44px; soporte de modo claro/oscuro y `prefers-reduced-motion`.

**Íconos:** estilo Lucide, SVG inline dibujados a mano (stroke 2, sin relleno, `currentColor`), sin Font Awesome ni Material ni emojis en KPIs o headers de sección.

**Nota de contraste (WCAG AA):** varios colores "puros" del manual no alcanzan 4.5:1 (texto) o 3:1 (componentes UI) sobre ciertas superficies — notablemente `crimson` y `olive` como texto, y `amber` como outline de foco sobre tarjetas blancas. El prototipo resuelve esto con variantes de texto (`--crimson-text`, `--olive-text`, `--amber-text`) más saturadas/oscuras según el tema, y con un amber oscurecido (`#B8790A`) solo para el anillo de foco en modo claro. El color base del manual se preserva íntegro para fondos, íconos y gradientes. Ratios verificados con la fórmula de contraste relativo de WCAG; ver el detalle en el historial de cambios.

## Pendientes

- Construir la WebApp real de Apps Script (`doGet`/`doPost` con `HtmlService`) a partir del prototipo aprobado, usando `include()`, `validarCompensacion()` y el directorio de `Correos` como fuente de datos.
- Cargar la hoja `Correos` con los datos reales del equipo antes de poner el sistema en producción.
- Deuda técnica histórica y contexto de decisiones en el handoff (`docs/HANDOFF_ControlHorasExtra.md`) — parte de esa deuda (índices hardcodeados, saldo insuficiente sin bloquear, limpieza de `resumenMensual`) ya se resolvió en este refactor.

> Idioma del proyecto: español rioplatense. Identificadores de código sin tildes.
