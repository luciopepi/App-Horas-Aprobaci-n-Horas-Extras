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

`Email | Nombre | Rol | Linea | Activo`

- `Rol`: `Supervisor` | `Jefe` | `RRHH` (con validación de datos en la celda).
- `Activo`: `SI` | `NO` (con validación de datos en la celda).
- Tiene que haber **al menos un Jefe activo** cargado para que el sistema pueda notificar y aprobar.
- El script lee esta hoja a través de `_directorio()`, con cache de 5 minutos (`CacheService`). Si editás la hoja y necesitás que el cambio se vea al toque, corré manualmente `invalidarCacheDirectorio()` desde el editor de Apps Script.

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

Incluye selector de rol (Supervisor / Jefe), ambas vistas completas, modales de carga y compensación, animaciones de éxito/aprobación, y modo claro/oscuro.

### Sistema de diseño

| Token | Valor | Uso |
|---|---|---|
| `--vspt-bordo` | `#7B2233` | Color primario de marca |
| `--vspt-bordo-profundo` | `#5A1826` | Variante oscura del primario |
| `--vspt-terracota` | `#B85C38` | Acento tierra |
| `--vspt-cobre` | `#C2703D` | Acento secundario |
| `--vspt-oro` | `#D9A441` | Estado pendiente / detalles |
| `--vspt-crema` | `#F2EDE4` | Superficie clara |
| `--vspt-tinta` | `#1A1013` | Fondo oscuro |
| `--ok` | `#1B7F4B` | Estado aprobado |
| `--error` | `#B00020` | Estado rechazado / error |
| `--pendiente` | `#D9A441` | Estado pendiente |

Lineamientos: fondo con gradientes radiales orgánicos (bordó / terracota / tinta) y "blobs" animados de fondo; superficies con glassmorphism (`backdrop-filter: blur(20px) saturate(140%)`); radios de 18-22px en tarjetas, 14px en botones, 26px en modales; tipografía de sistema con números tabulares (`font-variant-numeric: tabular-nums`); animaciones de apertura de modal, éxito/aprobado (checkmark dibujado + onda) y listas con entrada escalonada; diseño mobile-first (390px en adelante) con áreas táctiles ≥44px; soporte completo de modo claro/oscuro y de `prefers-reduced-motion`; contraste de texto ajustado a WCAG AA en ambos modos.

## Pendientes

- Construir la WebApp real de Apps Script (`doGet`/`doPost` con `HtmlService`) a partir del prototipo aprobado, usando `include()`, `validarCompensacion()` y el directorio de `Correos` como fuente de datos.
- Cargar la hoja `Correos` con los datos reales del equipo antes de poner el sistema en producción.
- Deuda técnica histórica y contexto de decisiones en el handoff (`docs/HANDOFF_ControlHorasExtra.md`) — parte de esa deuda (índices hardcodeados, saldo insuficiente sin bloquear, limpieza de `resumenMensual`) ya se resolvió en este refactor.

> Idioma del proyecto: español rioplatense. Identificadores de código sin tildes.
