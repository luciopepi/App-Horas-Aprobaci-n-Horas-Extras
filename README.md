# Sistema de Control y Aprobación de Horas Extra

Sistema para que los **supervisores** carguen sus horas extra y días de compensación, y el **Jefe de Fraccionamiento** los apruebe desde el mismo correo o desde una WebApp propia, con notificación automática y acumulación de saldo.

**Contexto:** VSPT Wine Group — Planta Graffigna, San Juan, Argentina. Área de Fraccionamiento (~50 personas, 3 líneas L1/L2/L3).

**Estado:** en producción. El flujo por Google Forms + mail con botones de aprobación funciona de punta a punta. Además ya está construida la **WebApp real** ([`webapp/`](webapp/)) a partir del prototipo aprobado: supervisores, Jefe y Gerencia de Personas la usan desde el celular sin pasar por el formulario. El prototipo visual ([`prototipo/prototipo.html`](prototipo/prototipo.html)) se conserva como maqueta de referencia del sistema de diseño, con datos mock. Ver también [`docs/HANDOFF_ControlHorasExtra.md`](docs/HANDOFF_ControlHorasExtra.md) (contexto histórico del diseño original).

---

## Funcionalidades

- Carga de horas extra por parte del supervisor, desde el **Google Form** o desde la **WebApp**.
- Notificación al correo del jefe con botones **APROBAR / RECHAZAR** (link con token único, sin abrir la planilla) — sigue existiendo tal cual además de la WebApp.
- Acumulación del saldo de horas aprobadas por supervisor.
- Segundo flujo: solicitud de **días de compensación** contra ese saldo. Por Google Form, si el saldo no alcanza la solicitud **queda igual en Pendiente** con la alerta visible en el mail: la decisión es del jefe. Por la **WebApp**, en cambio, el saldo insuficiente **bloquea el alta** — ahí sí corresponde bloquear porque es reversible (el supervisor corrige y reenvía en el momento). Son dos caminos con reglas distintas a propósito.
- Aprobar una compensación en descubierto (saldo ya no alcanza al momento de aprobar) pide confirmación explícita, tanto por mail como en la WebApp, y queda asentado en la auditoría.
- Copia informativa a Gerencia de Personas.
- **Resumen mensual** automático enviado al jefe (día 1, 07:00).
- Directorio de correos y roles administrable desde una hoja propia (`Correos`), sin tocar el código.
- Vista de solo lectura para **Gerencia de Personas** en la WebApp: saldos de todo el equipo, sin botones de aprobación ni edición.

## Arquitectura

| Capa | Tecnología |
|---|---|
| Base de datos | Google Sheet `DB_HorasExtra` |
| Ingreso de datos | Google Forms (2: horas extra y compensación) **o** la WebApp |
| Lógica, API y notificaciones | Google Apps Script ([`ControlHorasExtra.gs`](ControlHorasExtra.gs)) |
| Aprobación por mail | Botón en el mail → `doGet` con `id`+`token`+`accion` (sin sesión necesariamente) |
| WebApp | [`webapp/Index.html`](webapp/Index.html) + [`webapp/Estilos.html`](webapp/Estilos.html) + [`webapp/JsApp.html`](webapp/JsApp.html), servida por el mismo `doGet` cuando la URL no trae `id`+`token`+`accion`. Usa `google.script.run` contra la API del `.gs` (`apiEstado`, `apiCrearHoraExtra`, `apiCrearCompensacion`, `apiResolver`) |
| Prototipo de diseño | [`prototipo/prototipo.html`](prototipo/prototipo.html) — maqueta con datos mock, no se despliega |

## Modelo de datos (`DB_HorasExtra`)

**Hoja `Solicitudes`**

`ID | Timestamp | Supervisor | Email | Fecha HE | Horas | Linea | Motivo | Estado | Aprobado por | Fecha aprobacion | Comentario | Token`

**Hoja `Compensaciones`**

`ID | Timestamp | Supervisor | Email | Fecha solicitada | Horas a compensar | Tipo | Estado | Aprobado por | Fecha aprobacion | Comentario | Token`

**Hoja `Auditoria`**

`Timestamp | ID | Accion | Usuario | Detalle`

**Hoja `Correos`** (directorio de personas — reemplaza a `CONFIG.JEFE_EMAIL` / `CONFIG.RRHH_EMAILS`)

`Email | Nombre | Rol | Activo`

- `Rol`: `Supervisor` | `Jefe` | `Personas` (con validación de datos en la celda). El área se llama Gerencia de Personas, así que ese es el nombre canónico del rol; el código sigue aceptando `RRHH` y `Gestión de Personas` como sinónimos para no romper planillas cargadas con la nomenclatura anterior.
- `Activo`: `SI` | `NO` (con validación de datos en la celda).
- **Sin columna `Linea`**: un supervisor puede cubrir más de una línea, así que no tiene sentido atarle una fija en el directorio. La línea se elige en cada carga, en la hoja `Solicitudes` (columna `Linea` de esa hoja, sin cambios).
- Tiene que haber **al menos un Jefe activo** cargado para que el sistema pueda notificar y aprobar. El rol `Personas` solo da acceso de **lectura** (copia informativa de mails y, en el prototipo, la vista de consulta) — no aprueba ni edita nada.
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
6. Crear 3 archivos HTML en el **mismo** proyecto de Apps Script (▸ **Archivo → Nuevo → Archivo HTML**), con estos nombres exactos, y pegarles el contenido de los archivos homónimos de la carpeta [`webapp/`](webapp/) del repo. Apps Script no tiene subcarpetas: los archivos van sueltos, la carpeta `webapp/` es solo organización del repositorio.
   - `Index.html` ← [`webapp/Index.html`](webapp/Index.html)
   - `Estilos.html` ← [`webapp/Estilos.html`](webapp/Estilos.html)
   - `JsApp.html` ← [`webapp/JsApp.html`](webapp/JsApp.html)
7. **Implementar → Nueva implementación → Aplicación web** con *Ejecutar como: YO* y *Acceso: Cualquier usuario de <dominio de la empresa>*. El acceso por dominio (y no «cualquier usuario») es lo que hace que Google bloquee el login de cuentas ajenas y que `Session.getActiveUser().getEmail()` devuelva el correo real de quien usa la app. Copiar la URL a `CONFIG.WEBAPP_URL`.
8. Activadores:
   - `onFormSubmitHE` → *Desde hoja de cálculo / Al enviar formulario*.
   - `resumenMensual` → *Basado en tiempo / Mensual, día 1, 07:00*.

## Configuración (`CONFIG` en el `.gs`)

| Clave | Descripción |
|---|---|
| `WEBAPP_URL` | URL de la WebApp (se obtiene tras implementar) |
| `NOMBRE_PLANTA` | Nombre que aparece en mails y resúmenes |
| `HORAS_POR_DIA` | Equivalencia día → horas para compensación (8) |
| `TZ` | `America/Argentina/San_Juan` |

Los correos del jefe y de Gerencia de Personas **ya no están en `CONFIG`**: se leen dinámicamente de la hoja `Correos` mediante `jefeEmail()` y `personasEmails()`.

## WebApp (`webapp/`)

### Acceso

La URL de la WebApp es la misma `CONFIG.WEBAPP_URL` que ya se usa para los botones del mail (`doGet` rutea según los parámetros: con `id`+`token`+`accion` es un click desde el mail, sin esos parámetros sirve la app). Compartile esa URL al equipo — todos son Android, así que conviene agregarla como acceso directo:

1. Abrir la URL en **Chrome** en el celular, con la cuenta de Google de la empresa.
2. Menú (⋮, arriba a la derecha) → **Agregar a pantalla principal** (o "Instalar app", según versión de Chrome).
3. Confirmar el nombre ("Horas Extra - Graffigna") y agregar.

Queda un ícono en el escritorio que abre la WebApp en una ventana propia (sin la barra de direcciones de Chrome), como una app instalada.

### Qué ve cada rol

No hay selector de rol en la WebApp — a diferencia del prototipo, que lo tiene para poder mostrar las tres vistas en una demo. El rol lo determina el servidor por la sesión de Google de quien entra (`_identificar()`), leyendo la hoja `Correos`. Cada persona ve **solo** la vista que le corresponde:

| Rol | Ve |
|---|---|
| Supervisor | Su saldo (generadas/compensadas/disponible) y sus propias solicitudes y compensaciones. Puede cargar horas extra y pedir compensación. |
| Jefe | La bandeja de pendientes (para aprobar/rechazar) y los saldos de todo el equipo. También puede cargar sus propias horas extra y compensaciones. |
| Personas | Solo lectura: KPIs de planta (HE del mes, pendientes, saldo total) y la tabla de saldos por supervisor. Sin botones de acción. |

Si la cuenta no está en la hoja `Correos` (o está pero con `Activo = NO`), la WebApp muestra una pantalla de error explicando que hay que pedir el alta, en vez de una pantalla en blanco o rota.

### API (`google.script.run`)

Todas las funciones expuestas abajo arrancan resolviendo `_identificar()`: el email sale de `Session.getActiveUser().getEmail()` (la sesión real de Google, gracias al *Acceso: dominio* del despliegue) y el rol sale de la hoja `Correos` — **nunca de un dato que mande el cliente**. Cada función además filtra los datos en el servidor según ese rol antes de devolver nada.

| Función | Quién puede llamarla | Qué valida en el servidor |
|---|---|---|
| `apiEstado()` | Cualquier cuenta identificada (con rol en `Correos`) | Devuelve datos distintos según el rol de la sesión: un Supervisor nunca recibe `equipo` ni `pendientes`; un Supervisor jamás recibe los datos de otro Supervisor (todo se filtra por email, del lado del servidor). |
| `apiCrearHoraExtra({fecha, horas, linea, motivo})` | Supervisor o Jefe | Fecha válida y no futura; horas numérico entre 0,5 y 24; línea en `L1`/`L2`/`L3`/`Varias`; motivo no vacío. El email y el nombre son siempre los de la sesión, nunca los que mande el payload. |
| `apiCrearCompensacion({fecha, tipo})` | Supervisor o Jefe | Fecha válida; tipo `completo` o `medio`. Las **horas las calcula el servidor** a partir del tipo (nunca un número que mande el cliente, para que no se pueda manipular el saldo con un payload armado a mano). **Bloquea si el saldo no alcanza** — es el único lugar del sistema donde el bloqueo es correcto, porque acá es reversible. |
| `apiResolver(id, accion, confirmar)` | Solo Jefe | `accion` en `aprobar`/`rechazar`; idempotencia (si la solicitud ya no está Pendiente, error claro); lock para evitar carreras; si es una compensación con saldo insuficiente, no aprueba ni rechaza sola — devuelve un estado intermedio (`requiereConfirmacion`) que la UI muestra como "aprobar en descubierto", y recién con `confirmar=true` se aprueba, quedando `APROBADA_SALDO_NEGATIVO` en `Auditoria`. |

El flujo de aprobación por el botón del mail (`doGet` con `id`+`token`+`accion`) es independiente de `apiResolver` a propósito: es el que está en producción, tiene su propia validación de token y su propio manejo de "sin sesión" (cuando el Jefe abre el link sin estar logueado), y no se tocó su lógica interna al construir la WebApp.

### Estados de la interfaz

Mientras `apiEstado()` está en vuelo se muestra un esqueleto de carga (nunca una pantalla en blanco). Si no hay solicitudes o no hay pendientes, se muestra un estado vacío con ícono y texto en vez de una lista vacía. Después de cargar o resolver una solicitud, la UI **vuelve a pedir `apiEstado()` al servidor** en vez de actualizarse sola asumiendo que la operación salió bien.

## Prototipo visual (`prototipo/prototipo.html`)

Maqueta navegable, autocontenida (sin CDNs ni dependencias externas), con datos mock. Se usó para aprobar el diseño antes de construir la WebApp real (`webapp/`) y se conserva como referencia del sistema de diseño — no se despliega ni se toca al actualizar la WebApp. Se abre directamente en el navegador (doble clic al archivo).

Incluye selector de rol (Supervisor / Jefe / Personas), las tres vistas completas (la de Personas es de solo lectura), modales de carga y compensación, animaciones de éxito/aprobación, y modo claro/oscuro.

### Sistema de diseño

Sigue el **manual de diseño oficial de VSPT** (no es una paleta inventada). Tipografía y color son de uso obligatorio tal como están documentados acá; no se agregan variaciones.

**Tipografía — Montserrat, única familia del sistema.** El prototipo la embebe como `@font-face` con el archivo variable en data URI (pesos 100-900) porque no puede depender de una CDN de fuentes. La WebApp real (`webapp/Index.html`) en cambio usa el `<link>` de Google Fonts del manual, con la pila de sistema como *fallback*: no tiene el CSP que bloquea CDNs en el prototipo, así que no hace falta embeberla ahí.

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

- Probar la WebApp con cuentas reales de cada rol (Supervisor, Jefe, Personas) antes de compartir el acceso directo a todo el equipo.
- Deuda técnica histórica y contexto de decisiones en el handoff (`docs/HANDOFF_ControlHorasExtra.md`) — la mayor parte (índices hardcodeados, saldo insuficiente sin bloquear en el lugar equivocado, limpieza de `resumenMensual`, formato de fecha/horas en los mails) ya se resolvió en refactors posteriores a ese documento.

> Idioma del proyecto: español rioplatense. Identificadores de código sin tildes.
