# Handoff — Sistema de Control de Horas Extra (Supervisores)

**Contexto:** VSPT Wine Group — Planta Graffigna, San Juan, Argentina. Área de Fraccionamiento de vino para exportación. ~50 personas, 3 líneas (L1, L2, L3). El solicitante es el Jefe de Fraccionamiento.

**Estado:** diseño cerrado, script base escrito y sin probar. Falta build de AppSheet y detalle de expresiones.

**Idioma:** todo el proyecto (código, comentarios, UI, mails) en español rioplatense. Sin tildes en identificadores de código.

---

## 1. Requerimiento original

Sistema para que los supervisores carguen sus horas extra y el jefe las apruebe:

- Formulario de carga de HE por parte del supervisor.
- Notificación al correo laboral del jefe y/o al celular.
- Aprobación desde el mismo correo o notificación (sin abrir la planilla).
- Acumulación del total de horas aprobadas por supervisor (saldo).
- RRHH / Gestión de Personas informada del flujo.
- Resumen mensual con la totalidad enviado automáticamente.
- Segundo flujo: solicitud de días de compensación contra ese saldo, también con aprobación del jefe y notificación al correo.

## 2. Decisiones tomadas

| Decisión | Valor |
|---|---|
| Plataforma base | Google Forms + Sheets + Apps Script |
| Mecanismo de aprobación | Botón en el mail (link con token único) |
| Rol de RRHH | Solo copia informativa — sin segunda aprobación |
| Frontend móvil | **AppSheet** sobre el mismo Sheet (decisión final) |
| Alternativas descartadas | PWA sobre WebApp de Apps Script (sin push nativa); app nativa Flutter/Kotlin + FCM (esfuerzo alto) |

**Motivo de AppSheet:** reutiliza la Sheet como base de datos, aporta push nativa en Android sin programar, y los mails con botón quedan como respaldo. El tier Core está incluido sin costo adicional en varias ediciones de Google Workspace — **verificar la licencia de VSPT antes de avanzar**. Sin licencia, el modo gratuito permite hasta 10 usuarios (alcanza para la dotación de supervisores). Planes pagos: Starter USD 5 y Core USD 10 por usuario/mes.

## 3. Modelo de datos — Sheet `DB_HorasExtra`

**Hoja `Solicitudes`** (col. 0-indexadas entre paréntesis, las usa el script)

`ID(0) | Timestamp(1) | Supervisor(2) | Email(3) | Fecha HE(4) | Horas(5) | Linea(6) | Motivo(7) | Estado(8) | Aprobado por(9) | Fecha aprobacion(10) | Comentario(11) | Token(12)`

**Hoja `Compensaciones`**

`ID(0) | Timestamp(1) | Supervisor(2) | Email(3) | Fecha solicitada(4) | Horas a compensar(5) | Tipo(6) | Estado(7) | Aprobado por(8) | Fecha aprobacion(9) | Comentario(10) | Token(11)`

**Hoja `Auditoria`**

`Timestamp | ID | Accion | Usuario | Detalle`

Convenciones:
- `ID` prefijo `HE-` o `CP-` + `yyMMdd-HHmmss`. El prefijo es lo que usa `doGet` para saber a qué hoja ir.
- `Estado`: `Pendiente` | `Aprobada` | `Rechazada`.
- `Token`: UUID, siempre en la **última** columna (el `doGet` lo localiza por posición).
- **Saldo** = suma de `Horas` de `Solicitudes` aprobadas − suma de `Horas a compensar` de `Compensaciones` aprobadas, agrupado por `Email`.
- `HORAS_POR_DIA = 8` para convertir días de compensación a horas.

## 4. Código Apps Script

Archivo adjunto: `ControlHorasExtra.gs`. Funciones principales:

| Función | Rol |
|---|---|
| `setup()` | Crea las 3 hojas con encabezados. Ejecutar una vez. |
| `onFormSubmitHE(e)` | Trigger único para ambos formularios. Rutea por el nombre de la hoja destino: contiene `COMP` → compensación, si no → horas extra. |
| `doGet(e)` | WebApp. Params `id`, `token`, `accion`. Valida token, verifica que el estado sea `Pendiente`, actualiza, loguea y notifica. Idempotente: rechaza reprocesar. |
| `saldoSupervisor(email)` | Saldo individual en horas. |
| `tablaSaldos()` | Mapa email → {nombre, generadas, compensadas}. |
| `resumenMensual()` | Mail HTML del mes cerrado al jefe + CC RRHH. Trigger mensual día 1, 07:00. |

Bloque `CONFIG` a completar antes de usar: `JEFE_EMAIL`, `RRHH_EMAILS`, `WEBAPP_URL` (se obtiene recién después de implementar la WebApp), `HORAS_POR_DIA`, `TZ` = `America/Argentina/San_Juan`.

Implementación de la WebApp: *Ejecutar como YO* + *Acceso: cualquier usuario*. Sin eso el botón del mail falla.

### Deuda técnica conocida en el script

1. `resumenMensual()` tiene una variable `s` declarada y no usada dentro del `forEach`, y hace un doble lookup redundante sobre `saldos`. Limpiar.
2. Los nombres de campo del Form se leen con fallbacks encadenados (`get('Supervisor') || get('Nombre')`). Frágil. Una vez definidos los títulos reales de los formularios, fijarlos.
3. `_altaCompensacion` solo **advierte** por saldo insuficiente, no bloquea. La validación dura va en AppSheet (`Valid_If`).
4. Sin manejo de reintentos ni cuotas de `MailApp`.
5. Los índices de columna están hardcodeados en `saldoSupervisor()` y `tablaSaldos()`. Si cambia el esquema, se rompe en silencio. Candidato a refactor con lookup por nombre de encabezado.

## 5. Trabajo pendiente — build de AppSheet

Crear la app: appsheet.com → *Create app* → *Start with existing data* → seleccionar `DB_HorasExtra`.

| Ítem | Configuración |
|---|---|
| Tabla `Auditoria` | Read-only |
| `Estado` | Enum Pendiente/Aprobada/Rechazada. Initial value `Pendiente`. Editable solo por el jefe. |
| `Email` | Initial value `USEREMAIL()`, no editable |
| `Token` | Oculto en la UI |
| Security filter | Supervisor: `[Email] = USEREMAIL()`. Jefe: acceso total. |
| Vista *Pendientes* | Deck view, filtro `[Estado] = "Pendiente"`, visible solo para el jefe |
| Acciones | Botones *Aprobar* / *Rechazar*: set `Estado`, `Aprobado por` = `USEREMAIL()`, `Fecha aprobacion` = `NOW()` |
| Bot 1 | Fila agregada en `Solicitudes` → push al jefe |
| Bot 2 | Cambia `Estado` → push al supervisor + mail con CC a RRHH |
| Vista *Mi saldo* | Columna virtual con generadas − compensadas |

**Validación crítica:** `Valid_If` en `Horas a compensar` que impida superar el saldo disponible.

**Coexistencia con el script:** al migrar a AppSheet, **desactivar el trigger `onFormSubmitHE`** para no duplicar mails. Mantener activo `resumenMensual()`.

### Entregable inmediato solicitado

Expresiones de AppSheet listas para copiar y pegar:
- Columna virtual de saldo por supervisor (en `Solicitudes` o en una tabla derivada de usuarios).
- `Valid_If` de `Horas a compensar`.
- Condiciones (`Condition`) de los dos bots.
- `Show_If` de la vista de pendientes.

## 6. Personas del flujo

- **Jefe de Fraccionamiento** — único aprobador de ambos flujos.
- **Gestión de Personas / RRHH** — dos contactos, en copia informativa y receptores del resumen mensual.
- **Supervisores** — cargan HE y solicitan compensación. Incluye a los que acumularon HE en la ventana de despachos de exportación feb–mar 2026.

## 7. Restricciones del entorno

- PC corporativa con restricciones de instalación: preferir trabajo 100% en navegador. Nada de dependencias locales.
- Ecosistema Google Workspace ya en uso (el usuario mantiene otros dashboards en Apps Script sobre Sheets).
- Existe un dashboard operativo separado (`DB_Dashboard_Operaciones`) que ya reporta horas extra a nivel planta. Verificar si conviene alimentarlo desde `DB_HorasExtra` en lugar de duplicar la carga.

## 8. Preferencias de trabajo del usuario

- Respuestas concisas, sin preámbulos ni cierres de cortesía.
- Ediciones quirúrgicas: entregar solo el bloque de código a reemplazar, no el archivo completo.
- Confirmar el plan antes de ejecutar.
- Listas y tablas por sobre párrafos densos.
- Ingeniero industrial: asume vocabulario técnico de operaciones, KPIs y producción.

---

## Anexo — ControlHorasExtra.gs (codigo completo)

```javascript
/**
 * CONTROL DE HORAS EXTRA - SUPERVISORES
 * VSPT / Planta Graffigna
 *
 * INSTALACION:
 *  1. Crear un Google Sheet llamado DB_HorasExtra.
 *  2. Extensiones > Apps Script > pegar este codigo.
 *  3. Ejecutar setup() una vez (crea hojas y encabezados).
 *  4. Crear los 2 Google Forms (ver createForms() abajo, o manual).
 *  5. Vincular respuestas de ambos forms a este Sheet.
 *  6. Implementar > Nueva implementacion > Aplicacion web
 *       Ejecutar como: YO   |   Acceso: Cualquier usuario
 *     Copiar la URL y pegarla en CONFIG.WEBAPP_URL.
 *  7. Activadores: onFormSubmitHE  -> Desde hoja de calculo / Al enviar formulario
 *                  resumenMensual  -> Basado en tiempo / Mensual dia 1, 07:00
 */

// ============================ CONFIG ============================
const CONFIG = {
  JEFE_EMAIL:    'lucio@ejemplo.com',           // <-- tu correo laboral
  RRHH_EMAILS:   'estela@ejemplo.com,jonathan@ejemplo.com', // copia informativa
  WEBAPP_URL:    'https://script.google.com/macros/s/XXXX/exec', // <-- pegar tras implementar
  NOMBRE_PLANTA: 'Planta Graffigna - Fraccionamiento',
  HORAS_POR_DIA: 8,        // equivalencia para compensacion en dias
  TZ:            'America/Argentina/San_Juan'
};

const SH = { SOL: 'Solicitudes', COMP: 'Compensaciones', LOG: 'Auditoria' };

const COL_SOL  = ['ID','Timestamp','Supervisor','Email','Fecha HE','Horas','Linea','Motivo',
                  'Estado','Aprobado por','Fecha aprobacion','Comentario','Token'];
const COL_COMP = ['ID','Timestamp','Supervisor','Email','Fecha solicitada','Horas a compensar',
                  'Tipo','Estado','Aprobado por','Fecha aprobacion','Comentario','Token'];
const COL_LOG  = ['Timestamp','ID','Accion','Usuario','Detalle'];

// ============================ SETUP ============================
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  _ensureSheet(ss, SH.SOL,  COL_SOL);
  _ensureSheet(ss, SH.COMP, COL_COMP);
  _ensureSheet(ss, SH.LOG,  COL_LOG);
  SpreadsheetApp.getUi().alert('Hojas creadas. Configurar CONFIG y crear los formularios.');
}

function _ensureSheet(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#7B2233').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ==================== INGRESO DESDE FORMULARIO ====================
/**
 * Activador unico para ambos formularios.
 * Detecta el tipo por la hoja destino de las respuestas.
 * IMPORTANTE: los forms deben escribir en hojas cuyo nombre contenga
 * "HE" (horas extra) o "COMP" (compensacion).
 */
function onFormSubmitHE(e) {
  const hojaOrigen = e.range.getSheet().getName().toUpperCase();
  const v = e.namedValues;
  const get = k => (v[k] && v[k][0]) ? v[k][0].trim() : '';

  if (hojaOrigen.indexOf('COMP') >= 0) {
    _altaCompensacion(get);
  } else {
    _altaHorasExtra(get);
  }
}

function _altaHorasExtra(get) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH.SOL);
  const id = 'HE-' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyMMdd-HHmmss');
  const token = Utilities.getUuid();

  const supervisor = get('Supervisor') || get('Nombre');
  const email      = get('Email') || get('Direccion de correo electronico');
  const fechaHE    = get('Fecha de las horas extra') || get('Fecha');
  const horas      = parseFloat((get('Cantidad de horas') || get('Horas')).replace(',', '.')) || 0;
  const linea      = get('Linea') || get('Sector');
  const motivo     = get('Motivo');

  sh.appendRow([id, new Date(), supervisor, email, fechaHE, horas, linea, motivo,
                'Pendiente', '', '', '', token]);

  _log(id, 'ALTA_HE', email, horas + ' hs - ' + fechaHE);

  MailApp.sendEmail({
    to: CONFIG.JEFE_EMAIL,
    subject: '[HE Pendiente] ' + supervisor + ' - ' + horas + ' hs - ' + fechaHE,
    htmlBody: _mailAprobacion({
      titulo: 'Solicitud de Horas Extra',
      id: id, token: token, tipo: 'HE',
      filas: [
        ['Supervisor', supervisor],
        ['Fecha HE', fechaHE],
        ['Horas', horas],
        ['Linea / Sector', linea],
        ['Motivo', motivo]
      ]
    })
  });
}

function _altaCompensacion(get) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH.COMP);
  const id = 'CP-' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyMMdd-HHmmss');
  const token = Utilities.getUuid();

  const supervisor = get('Supervisor') || get('Nombre');
  const email      = get('Email') || get('Direccion de correo electronico');
  const fecha      = get('Fecha a compensar') || get('Fecha');
  const tipo       = get('Tipo') || 'Dia completo';
  let horas        = parseFloat((get('Horas a compensar') || '').replace(',', '.'));
  if (!horas) horas = (tipo.toUpperCase().indexOf('MEDIO') >= 0)
                      ? CONFIG.HORAS_POR_DIA / 2 : CONFIG.HORAS_POR_DIA;

  const saldo = saldoSupervisor(email);
  const alerta = (horas > saldo)
    ? '<p style="color:#B00020;font-weight:bold">ATENCION: saldo insuficiente (saldo actual: '
      + saldo.toFixed(1) + ' hs).</p>' : '';

  sh.appendRow([id, new Date(), supervisor, email, fecha, horas, tipo,
                'Pendiente', '', '', '', token]);

  _log(id, 'ALTA_COMP', email, horas + ' hs - ' + fecha);

  MailApp.sendEmail({
    to: CONFIG.JEFE_EMAIL,
    subject: '[Compensacion Pendiente] ' + supervisor + ' - ' + fecha,
    htmlBody: alerta + _mailAprobacion({
      titulo: 'Solicitud de Compensacion',
      id: id, token: token, tipo: 'CP',
      filas: [
        ['Supervisor', supervisor],
        ['Fecha solicitada', fecha],
        ['Tipo', tipo],
        ['Horas a descontar', horas],
        ['Saldo disponible', saldo.toFixed(1) + ' hs']
      ]
    })
  });
}

// ==================== WEB APP (botones del mail) ====================
function doGet(e) {
  const p = e.parameter;
  if (!p.id || !p.token || !p.accion) return _html('Solicitud invalida.', '#B00020');

  const esComp = p.id.indexOf('CP-') === 0;
  const sh = SpreadsheetApp.getActiveSpreadsheet()
              .getSheetByName(esComp ? SH.COMP : SH.SOL);
  const data = sh.getDataRange().getValues();
  const cTok = data[0].length - 1;              // Token = ultima columna
  const cEst = data[0].indexOf('Estado');
  const cApr = data[0].indexOf('Aprobado por');
  const cFec = data[0].indexOf('Fecha aprobacion');

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] !== p.id) continue;
    if (String(data[i][cTok]) !== p.token) return _html('Token invalido.', '#B00020');
    if (data[i][cEst] !== 'Pendiente')
      return _html('Esta solicitud ya fue procesada (' + data[i][cEst] + ').', '#8A6D00');

    const estado = (p.accion === 'aprobar') ? 'Aprobada' : 'Rechazada';
    const quien  = Session.getActiveUser().getEmail() || CONFIG.JEFE_EMAIL;

    sh.getRange(i + 1, cEst + 1).setValue(estado);
    sh.getRange(i + 1, cApr + 1).setValue(quien);
    sh.getRange(i + 1, cFec + 1).setValue(new Date());

    _log(p.id, estado.toUpperCase(), quien, '');
    _notificarResultado(data[i], estado, esComp);

    return _html('Solicitud ' + p.id + ' <b>' + estado + '</b>.',
                 estado === 'Aprobada' ? '#1B7F4B' : '#B00020');
  }
  return _html('No se encontro la solicitud.', '#B00020');
}

function _notificarResultado(fila, estado, esComp) {
  const supervisor = fila[2], email = fila[3], fecha = fila[4], horas = fila[5];
  const asunto = (esComp ? '[Compensacion ' : '[Horas Extra ') + estado + '] ' + fecha;
  const cuerpo =
    '<p>Hola ' + supervisor + ',</p>' +
    '<p>Tu solicitud del <b>' + fecha + '</b> (' + horas + ' hs) fue <b>' +
    estado.toLowerCase() + '</b>.</p>' +
    '<p>Saldo actual de horas extra: <b>' + saldoSupervisor(email).toFixed(1) + ' hs</b>.</p>' +
    '<p style="font-size:11px;color:#777">' + CONFIG.NOMBRE_PLANTA + '</p>';

  MailApp.sendEmail({ to: email, cc: CONFIG.RRHH_EMAILS, subject: asunto, htmlBody: cuerpo });
}

// ==================== SALDOS ====================
function saldoSupervisor(email) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let saldo = 0;
  const acum = (hoja, cHoras, cEstado, cEmail) => {
    const d = ss.getSheetByName(hoja).getDataRange().getValues();
    for (let i = 1; i < d.length; i++)
      if (d[i][cEmail] === email && d[i][cEstado] === 'Aprobada')
        saldo += (hoja === SH.SOL ? 1 : -1) * (parseFloat(d[i][cHoras]) || 0);
  };
  acum(SH.SOL,  5, 8, 3);
  acum(SH.COMP, 5, 7, 3);
  return saldo;
}

function tablaSaldos() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const map = {};
  const rec = (hoja, cEstado, signo) => {
    const d = ss.getSheetByName(hoja).getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      if (d[i][cEstado] !== 'Aprobada') continue;
      const k = d[i][3];
      if (!map[k]) map[k] = { nombre: d[i][2], generadas: 0, compensadas: 0 };
      if (signo > 0) map[k].generadas   += parseFloat(d[i][5]) || 0;
      else           map[k].compensadas += parseFloat(d[i][5]) || 0;
    }
  };
  rec(SH.SOL, 8, 1);
  rec(SH.COMP, 7, -1);
  return map;
}

// ==================== RESUMEN MENSUAL ====================
function resumenMensual() {
  const hoy = new Date();
  const ini = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const fin = new Date(hoy.getFullYear(), hoy.getMonth(), 0, 23, 59, 59);
  const per = Utilities.formatDate(ini, CONFIG.TZ, 'MM/yyyy');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const d  = ss.getSheetByName(SH.SOL).getDataRange().getValues();
  const det = {};
  let total = 0, pend = 0;

  for (let i = 1; i < d.length; i++) {
    const ts = new Date(d[i][1]);
    if (ts < ini || ts > fin) continue;
    if (d[i][8] === 'Pendiente') { pend++; continue; }
    if (d[i][8] !== 'Aprobada') continue;
    const n = d[i][2];
    det[n] = (det[n] || 0) + (parseFloat(d[i][5]) || 0);
    total += parseFloat(d[i][5]) || 0;
  }

  const saldos = tablaSaldos();
  let filas = '';
  Object.keys(det).sort().forEach(n => {
    const s = Object.values(saldos).find(x => x.nombre === n) || { compensadas: 0 };
    const sal = Object.keys(saldos).map(k => saldos[k]).filter(x => x.nombre === n)[0];
    filas += '<tr><td>' + n + '</td><td style="text-align:right">' + det[n].toFixed(1) +
             '</td><td style="text-align:right">' + (sal ? (sal.generadas - sal.compensadas).toFixed(1) : '-') +
             '</td></tr>';
  });

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:640px">' +
    '<h2 style="color:#7B2233;margin-bottom:4px">Resumen de Horas Extra - ' + per + '</h2>' +
    '<p style="color:#666;margin-top:0">' + CONFIG.NOMBRE_PLANTA + '</p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:13px">' +
    '<tr style="background:#7B2233;color:#fff"><th align="left">Supervisor</th>' +
    '<th align="right">HE del mes</th><th align="right">Saldo acumulado</th></tr>' +
    filas +
    '<tr style="font-weight:bold;background:#F2EDE4"><td>TOTAL</td>' +
    '<td align="right">' + total.toFixed(1) + '</td><td></td></tr></table>' +
    (pend ? '<p style="color:#B00020">Solicitudes pendientes de aprobacion: ' + pend + '</p>' : '') +
    '</div>';

  MailApp.sendEmail({
    to: CONFIG.JEFE_EMAIL, cc: CONFIG.RRHH_EMAILS,
    subject: 'Resumen mensual de Horas Extra - ' + per,
    htmlBody: html
  });
}

// ==================== AUXILIARES ====================
function _mailAprobacion(o) {
  const url = a => CONFIG.WEBAPP_URL + '?id=' + o.id + '&token=' + o.token + '&accion=' + a;
  let filas = '';
  o.filas.forEach(f => {
    filas += '<tr><td style="padding:6px 12px 6px 0;color:#666">' + f[0] +
             '</td><td style="padding:6px 0"><b>' + f[1] + '</b></td></tr>';
  });
  return '<div style="font-family:Arial,sans-serif;max-width:520px">' +
    '<h2 style="color:#7B2233;margin-bottom:2px">' + o.titulo + '</h2>' +
    '<p style="color:#999;margin-top:0;font-size:12px">' + o.id + '</p>' +
    '<table style="font-size:14px">' + filas + '</table>' +
    '<p style="margin-top:24px">' +
    '<a href="' + url('aprobar') + '" style="background:#1B7F4B;color:#fff;padding:12px 28px;' +
    'text-decoration:none;border-radius:4px;font-weight:bold">APROBAR</a>&nbsp;&nbsp;' +
    '<a href="' + url('rechazar') + '" style="background:#B00020;color:#fff;padding:12px 28px;' +
    'text-decoration:none;border-radius:4px;font-weight:bold">RECHAZAR</a></p>' +
    '<p style="font-size:11px;color:#999">' + CONFIG.NOMBRE_PLANTA + '</p></div>';
}

function _html(msg, color) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;text-align:center;padding:60px">' +
    '<p style="font-size:18px;color:' + color + '">' + msg + '</p>' +
    '<p style="font-size:12px;color:#999">Podes cerrar esta ventana.</p></div>'
  ).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function _log(id, accion, usuario, detalle) {
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH.LOG)
    .appendRow([new Date(), id, accion, usuario, detalle]);
}
```
