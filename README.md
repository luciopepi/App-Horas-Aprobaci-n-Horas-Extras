# Sistema de Control y Aprobación de Horas Extra

Sistema para que los **supervisores** carguen sus horas extra y días de compensación, y el **Jefe de Fraccionamiento** los apruebe desde el mismo correo, con notificación automática y acumulación de saldo.

**Contexto:** VSPT Wine Group — Planta Graffigna, San Juan, Argentina. Área de Fraccionamiento (~50 personas, 3 líneas L1/L2/L3).

**Estado:** diseño cerrado, script base escrito y **sin probar**. Falta el build de AppSheet y el detalle de expresiones. Ver [`docs/HANDOFF_ControlHorasExtra.md`](docs/HANDOFF_ControlHorasExtra.md).

---

## Funcionalidades

- Carga de horas extra por parte del supervisor (Google Form).
- Notificación al correo del jefe con botones **APROBAR / RECHAZAR** (link con token único, sin abrir la planilla).
- Acumulación del saldo de horas aprobadas por supervisor.
- Segundo flujo: solicitud de **días de compensación** contra ese saldo, con la misma aprobación.
- Copia informativa a RRHH / Gestión de Personas.
- **Resumen mensual** automático enviado al jefe (día 1, 07:00).

## Arquitectura

| Capa | Tecnología |
|---|---|
| Base de datos | Google Sheet `DB_HorasExtra` |
| Ingreso de datos | Google Forms (2: horas extra y compensación) |
| Lógica y notificaciones | Google Apps Script ([`ControlHorasExtra.gs`](ControlHorasExtra.gs)) |
| Aprobación | Botón en el mail → WebApp (`doGet`) con token |
| Frontend móvil | AppSheet sobre el mismo Sheet (pendiente de build) |

## Modelo de datos (`DB_HorasExtra`)

**Hoja `Solicitudes`**

`ID | Timestamp | Supervisor | Email | Fecha HE | Horas | Linea | Motivo | Estado | Aprobado por | Fecha aprobacion | Comentario | Token`

**Hoja `Compensaciones`**

`ID | Timestamp | Supervisor | Email | Fecha solicitada | Horas a compensar | Tipo | Estado | Aprobado por | Fecha aprobacion | Comentario | Token`

**Hoja `Auditoria`**

`Timestamp | ID | Accion | Usuario | Detalle`

Convenciones:
- `ID`: prefijo `HE-` o `CP-` + `yyMMdd-HHmmss`. El prefijo enruta en `doGet`.
- `Estado`: `Pendiente` | `Aprobada` | `Rechazada`.
- `Token`: UUID, siempre en la última columna.
- **Saldo** = Σ `Horas` aprobadas (`Solicitudes`) − Σ `Horas a compensar` aprobadas (`Compensaciones`), por `Email`.

## Instalación

1. Crear un Google Sheet llamado `DB_HorasExtra`.
2. **Extensiones → Apps Script** y pegar [`ControlHorasExtra.gs`](ControlHorasExtra.gs).
3. Completar el bloque `CONFIG` (correos del jefe y RRHH, zona horaria).
4. Ejecutar `setup()` una vez (crea las 3 hojas con encabezados).
5. Crear los 2 Google Forms y vincular sus respuestas a este Sheet. Las hojas destino deben contener `HE` o `COMP` en el nombre (así rutea `onFormSubmitHE`).
6. **Implementar → Nueva implementación → Aplicación web** con *Ejecutar como: YO* y *Acceso: Cualquier usuario*. Copiar la URL a `CONFIG.WEBAPP_URL`.
7. Activadores:
   - `onFormSubmitHE` → *Desde hoja de cálculo / Al enviar formulario*.
   - `resumenMensual` → *Basado en tiempo / Mensual, día 1, 07:00*.

## Configuración (`CONFIG` en el `.gs`)

| Clave | Descripción |
|---|---|
| `JEFE_EMAIL` | Correo laboral del jefe (único aprobador) |
| `RRHH_EMAILS` | Correos de RRHH, separados por coma (copia informativa) |
| `WEBAPP_URL` | URL de la WebApp (se obtiene tras implementar) |
| `HORAS_POR_DIA` | Equivalencia día → horas para compensación (8) |
| `TZ` | `America/Argentina/San_Juan` |

## Pendientes

- Build de AppSheet (vistas, acciones Aprobar/Rechazar, bots de push, `Valid_If` de saldo). Detalle en el handoff.
- Al migrar a AppSheet: **desactivar** el trigger `onFormSubmitHE` para no duplicar mails; mantener `resumenMensual`.
- Deuda técnica del script listada en el handoff (sección 4).

> Idioma del proyecto: español rioplatense. Identificadores de código sin tildes.
