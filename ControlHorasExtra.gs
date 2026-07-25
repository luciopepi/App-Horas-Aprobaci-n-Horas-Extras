/**
 * CONTROL DE HORAS EXTRA - SUPERVISORES
 * VSPT / Planta Graffigna
 *
 * INSTALACION:
 *  1. Crear un Google Sheet llamado DB_HorasExtra.
 *  2. Extensiones > Apps Script > pegar este codigo.
 *  3. Ejecutar setup() una vez (crea las 4 hojas y encabezados).
 *  4. Completar la hoja "Correos" con los correos reales del equipo
 *     (Email | Nombre | Rol | Linea | Activo). Roles validos: Supervisor,
 *     Jefe, RRHH. Tiene que haber al menos un Jefe activo.
 *     IMPORTANTE: los correos NO van en el codigo ni en el repo, se
 *     cargan a mano en esta hoja.
 *  5. Crear los 2 Google Forms (horas extra y compensacion) y vincular
 *     sus respuestas a este Sheet.
 *  6. Implementar > Nueva implementacion > Aplicacion web
 *       Ejecutar como: YO   |   Acceso: Cualquier usuario
 *     Copiar la URL y pegarla en CONFIG.WEBAPP_URL.
 *  7. Activadores: onFormSubmitHE  -> Desde hoja de calculo / Al enviar formulario
 *                  resumenMensual  -> Basado en tiempo / Mensual dia 1, 07:00
 *
 * Si se edita la hoja "Correos" (alta, baja, cambio de rol o de activo),
 * correr invalidarCacheDirectorio() para que el cambio se refleje al toque
 * en jefeEmail(), rrhhEmails(), rolDe() y nombreDe(). Si no se corre, el
 * cambio se aplica solo igual, pero puede tardar hasta 5 minutos por el cache.
 */

// ============================ CONFIG ============================
const CONFIG = {
  WEBAPP_URL:    'https://script.google.com/macros/s/XXXX/exec', // <-- pegar tras implementar
  NOMBRE_PLANTA: 'Planta Graffigna - Fraccionamiento',
  HORAS_POR_DIA: 8,        // equivalencia para compensacion en dias
  TZ:            'America/Argentina/San_Juan'
};

const SH = { SOL: 'Solicitudes', COMP: 'Compensaciones', LOG: 'Auditoria', COR: 'Correos' };

const COL_SOL  = ['ID','Timestamp','Supervisor','Email','Fecha HE','Horas','Linea','Motivo',
                  'Estado','Aprobado por','Fecha aprobacion','Comentario','Token'];
const COL_COMP = ['ID','Timestamp','Supervisor','Email','Fecha solicitada','Horas a compensar',
                  'Tipo','Estado','Aprobado por','Fecha aprobacion','Comentario','Token'];
const COL_LOG  = ['Timestamp','ID','Accion','Usuario','Detalle'];
const COL_COR  = ['Email','Nombre','Rol','Linea','Activo'];

const ROLES_VALIDOS = ['Supervisor', 'Jefe', 'RRHH'];

const CACHE_KEY_DIRECTORIO = 'directorio_correos';
const CACHE_TTL_DIRECTORIO = 300; // segundos

// ============================ SETUP ============================
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  _ensureSheet(ss, SH.SOL,  COL_SOL);
  _ensureSheet(ss, SH.COMP, COL_COMP);
  _ensureSheet(ss, SH.LOG,  COL_LOG);
  _ensureHojaCorreos(ss);
  SpreadsheetApp.getUi().alert(
    'Hojas creadas. Completar la hoja "Correos" con los correos reales ' +
    '(al menos un Jefe activo) y revisar CONFIG.WEBAPP_URL tras implementar la WebApp.'
  );
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

function _ensureHojaCorreos(ss) {
  const esNueva = !ss.getSheetByName(SH.COR);
  const sh = _ensureSheet(ss, SH.COR, COL_COR);
  const filas = Math.max(sh.getMaxRows() - 1, 1);

  const colRol = _idx(COL_COR, 'Rol') + 1;
  const reglaRol = SpreadsheetApp.newDataValidation()
    .requireValueInList(ROLES_VALIDOS, true)
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, colRol, filas, 1).setDataValidation(reglaRol);

  const colActivo = _idx(COL_COR, 'Activo') + 1;
  const reglaActivo = SpreadsheetApp.newDataValidation()
    .requireValueInList(['SI', 'NO'], true)
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, colActivo, filas, 1).setDataValidation(reglaActivo);

  if (esNueva) {
    // Fila de ejemplo con placeholders: reemplazar por los datos reales.
    sh.appendRow(['jefe@ejemplo.com', 'M. Rivas', 'Jefe', '', 'SI']);
  }
}

// ==================== DIRECTORIO (hoja Correos) ====================
/**
 * Devuelve el listado de personas activas de la hoja "Correos" como
 * array de {email, nombre, rol, linea, activo}. Cachea el resultado
 * (scriptCache, 300s); si el cache falla, lee la hoja directamente.
 */
function _directorio() {
  const cache = _cacheSeguro();
  if (cache) {
    try {
      const cacheado = cache.get(CACHE_KEY_DIRECTORIO);
      if (cacheado) return JSON.parse(cacheado);
    } catch (err) {
      // si falla la lectura del cache, seguimos y leemos la hoja
    }
  }

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH.COR);
  if (!sh) return [];
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return [];

  const enc = data[0];
  const cEmail  = _idx(enc, 'Email');
  const cNombre = _idx(enc, 'Nombre');
  const cRol    = _idx(enc, 'Rol');
  const cLinea  = _idx(enc, 'Linea');
  const cActivo = _idx(enc, 'Activo');

  const directorio = [];
  for (let i = 1; i < data.length; i++) {
    const fila = data[i];
    if (!fila[cEmail]) continue;
    if (String(fila[cActivo]).trim().toUpperCase() !== 'SI') continue;
    directorio.push({
      email:  String(fila[cEmail]).trim(),
      nombre: String(fila[cNombre]).trim(),
      rol:    String(fila[cRol]).trim(),
      linea:  String(fila[cLinea]).trim(),
      activo: 'SI'
    });
  }

  if (cache) {
    try {
      cache.put(CACHE_KEY_DIRECTORIO, JSON.stringify(directorio), CACHE_TTL_DIRECTORIO);
    } catch (err) {
      // sin cache disponible no es critico, se vuelve a leer la hoja la proxima vez
    }
  }

  return directorio;
}

function _cacheSeguro() {
  try {
    return CacheService.getScriptCache();
  } catch (err) {
    return null;
  }
}

/**
 * Correr manualmente despues de editar la hoja "Correos" (alta, baja,
 * cambio de rol o de Activo) para que el cambio se vea de inmediato en
 * jefeEmail(), rrhhEmails(), rolDe() y nombreDe(). Sin esto, el cache
 * vence solo a los 5 minutos.
 */
function invalidarCacheDirectorio() {
  const cache = _cacheSeguro();
  if (!cache) return;
  try {
    cache.remove(CACHE_KEY_DIRECTORIO);
  } catch (err) {
    // sin cache no hay nada que borrar
  }
}

function jefeEmail() {
  const jefe = _directorio().find(p => p.rol === 'Jefe');
  if (!jefe) throw new Error('No hay ningun Jefe activo cargado en la hoja "Correos".');
  return jefe.email;
}

function rrhhEmails() {
  return _directorio().filter(p => p.rol === 'RRHH').map(p => p.email).join(',');
}

function rolDe(email) {
  if (!email) return null;
  const buscado = String(email).trim().toLowerCase();
  const persona = _directorio().find(p => p.email.trim().toLowerCase() === buscado);
  return persona ? persona.rol : null;
}

function nombreDe(email) {
  if (!email) return '';
  const buscado = String(email).trim().toLowerCase();
  const persona = _directorio().find(p => p.email.trim().toLowerCase() === buscado);
  return persona ? persona.nombre : email;
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
    to: jefeEmail(),
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

  const validacion = validarCompensacion(email, horas);

  if (!validacion.ok) {
    // Saldo insuficiente: se bloquea, no queda Pendiente ni puede aprobarse.
    sh.appendRow([id, new Date(), supervisor, email, fecha, horas, tipo,
                  'Rechazada', 'Sistema', new Date(),
                  'Auto-rechazada: ' + validacion.mensaje, token]);

    _log(id, 'ALTA_COMP_AUTORECHAZO', email, horas + ' hs - ' + fecha);

    MailApp.sendEmail({
      to: email,
      cc: rrhhEmails(),
      subject: '[Compensacion Rechazada] ' + supervisor + ' - ' + fecha,
      htmlBody:
        '<p>Hola ' + supervisor + ',</p>' +
        '<p>Tu solicitud de compensacion del <b>' + fecha + '</b> (' + horas +
        ' hs) fue <b>rechazada automaticamente</b> por saldo insuficiente.</p>' +
        '<p>' + validacion.mensaje + '</p>' +
        '<p style="font-size:11px;color:#777">' + CONFIG.NOMBRE_PLANTA + '</p>'
    });
    return;
  }

  sh.appendRow([id, new Date(), supervisor, email, fecha, horas, tipo,
                'Pendiente', '', '', '', token]);

  _log(id, 'ALTA_COMP', email, horas + ' hs - ' + fecha);

  MailApp.sendEmail({
    to: jefeEmail(),
    subject: '[Compensacion Pendiente] ' + supervisor + ' - ' + fecha,
    htmlBody: _mailAprobacion({
      titulo: 'Solicitud de Compensacion',
      id: id, token: token, tipo: 'CP',
      filas: [
        ['Supervisor', supervisor],
        ['Fecha solicitada', fecha],
        ['Tipo', tipo],
        ['Horas a descontar', horas],
        ['Saldo disponible', validacion.saldo.toFixed(1) + ' hs']
      ]
    })
  });
}

// ==================== VALIDACION DE SALDO ====================
/**
 * Fuente de verdad unica para saber si una compensacion se puede otorgar.
 * La usan tanto el alta por formulario (_altaCompensacion) como, a futuro,
 * la WebApp propia.
 */
function validarCompensacion(email, horas) {
  const saldo = saldoSupervisor(email);
  const horasNum = parseFloat(horas) || 0;

  if (horasNum <= 0) {
    return { ok: false, saldo: saldo, mensaje: 'La cantidad de horas a compensar debe ser mayor a cero.' };
  }
  if (horasNum > saldo) {
    return {
      ok: false,
      saldo: saldo,
      mensaje: 'Saldo insuficiente: disponible ' + saldo.toFixed(1) +
               ' hs, solicitado ' + horasNum.toFixed(1) + ' hs.'
    };
  }
  return { ok: true, saldo: saldo, mensaje: 'Saldo suficiente.' };
}

// ==================== WEB APP (botones del mail) ====================
function doGet(e) {
  const p = e.parameter;
  if (!p.id || !p.token || !p.accion) return _html('Solicitud invalida.', '#B00020');

  const lock = LockService.getScriptLock();
  let tieneLock = false;
  try {
    tieneLock = lock.tryLock(10000);
  } catch (err) {
    tieneLock = false;
  }
  if (!tieneLock) {
    return _html('El sistema esta ocupado procesando otra solicitud. Intenta de nuevo en unos segundos.', '#D9A441');
  }

  try {
    const esComp = p.id.indexOf('CP-') === 0;
    const sh = SpreadsheetApp.getActiveSpreadsheet()
                .getSheetByName(esComp ? SH.COMP : SH.SOL);
    const data = sh.getDataRange().getValues();
    if (data.length < 2) return _html('No se encontro la solicitud.', '#B00020');

    const enc = data[0];
    const cTok    = _idx(enc, 'Token');
    const cEst    = _idx(enc, 'Estado');
    const cApr    = _idx(enc, 'Aprobado por');
    const cFec    = _idx(enc, 'Fecha aprobacion');
    const cEmail  = _idx(enc, 'Email');
    const cHoras  = _idx(enc, esComp ? 'Horas a compensar' : 'Horas');

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] !== p.id) continue;
      if (String(data[i][cTok]) !== p.token) return _html('Token invalido.', '#B00020');
      if (data[i][cEst] !== 'Pendiente')
        return _html('Esta solicitud ya fue procesada (' + data[i][cEst] + ').', '#8A6D00');

      const estado = (p.accion === 'aprobar') ? 'Aprobada' : 'Rechazada';

      if (esComp && estado === 'Aprobada') {
        const validacion = validarCompensacion(data[i][cEmail], parseFloat(data[i][cHoras]) || 0);
        if (!validacion.ok) {
          return _html('No se puede aprobar: ' + validacion.mensaje, '#B00020');
        }
      }

      let quien = Session.getActiveUser().getEmail();
      if (!quien) {
        try { quien = jefeEmail(); } catch (err) { quien = 'Jefe'; }
      }

      sh.getRange(i + 1, cEst + 1).setValue(estado);
      sh.getRange(i + 1, cApr + 1).setValue(quien);
      sh.getRange(i + 1, cFec + 1).setValue(new Date());

      _log(p.id, estado.toUpperCase(), quien, '');
      _notificarResultado(data[i], estado, esComp);

      return _html('Solicitud ' + p.id + ' <b>' + estado + '</b>.',
                   estado === 'Aprobada' ? '#1B7F4B' : '#B00020');
    }
    return _html('No se encontro la solicitud.', '#B00020');
  } finally {
    lock.releaseLock();
  }
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

  MailApp.sendEmail({ to: email, cc: rrhhEmails(), subject: asunto, htmlBody: cuerpo });
}

// ==================== SALDOS ====================
function saldoSupervisor(email) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let saldo = 0;
  const acum = (hoja, signo) => {
    const d = ss.getSheetByName(hoja).getDataRange().getValues();
    if (d.length < 2) return;
    const enc = d[0];
    const cEmail  = _idx(enc, 'Email');
    const cEstado = _idx(enc, 'Estado');
    const cHoras  = _idx(enc, hoja === SH.SOL ? 'Horas' : 'Horas a compensar');
    for (let i = 1; i < d.length; i++)
      if (d[i][cEmail] === email && d[i][cEstado] === 'Aprobada')
        saldo += signo * (parseFloat(d[i][cHoras]) || 0);
  };
  acum(SH.SOL, 1);
  acum(SH.COMP, -1);
  return saldo;
}

function tablaSaldos() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const map = {};
  const rec = (hoja, signo) => {
    const d = ss.getSheetByName(hoja).getDataRange().getValues();
    if (d.length < 2) return;
    const enc = d[0];
    const cEmail  = _idx(enc, 'Email');
    const cNombre = _idx(enc, 'Supervisor');
    const cEstado = _idx(enc, 'Estado');
    const cHoras  = _idx(enc, hoja === SH.SOL ? 'Horas' : 'Horas a compensar');
    for (let i = 1; i < d.length; i++) {
      if (d[i][cEstado] !== 'Aprobada') continue;
      const k = d[i][cEmail];
      if (!map[k]) map[k] = { nombre: d[i][cNombre], generadas: 0, compensadas: 0 };
      if (signo > 0) map[k].generadas   += parseFloat(d[i][cHoras]) || 0;
      else           map[k].compensadas += parseFloat(d[i][cHoras]) || 0;
    }
  };
  rec(SH.SOL, 1);
  rec(SH.COMP, -1);
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
  const enc = d[0];
  const cTimestamp  = _idx(enc, 'Timestamp');
  const cSupervisor = _idx(enc, 'Supervisor');
  const cHoras      = _idx(enc, 'Horas');
  const cEstado     = _idx(enc, 'Estado');

  const det = {};
  let total = 0, pend = 0;

  for (let i = 1; i < d.length; i++) {
    const ts = new Date(d[i][cTimestamp]);
    if (ts < ini || ts > fin) continue;
    if (d[i][cEstado] === 'Pendiente') { pend++; continue; }
    if (d[i][cEstado] !== 'Aprobada') continue;
    const n = d[i][cSupervisor];
    det[n] = (det[n] || 0) + (parseFloat(d[i][cHoras]) || 0);
    total += parseFloat(d[i][cHoras]) || 0;
  }

  // Un solo lookup: mapa nombre -> saldo acumulado, armado una vez.
  const saldos = tablaSaldos();
  const saldoPorNombre = {};
  Object.keys(saldos).forEach(email => {
    const info = saldos[email];
    saldoPorNombre[info.nombre] = info.generadas - info.compensadas;
  });

  let filas = '';
  Object.keys(det).sort().forEach(n => {
    const saldoAcumulado = saldoPorNombre.hasOwnProperty(n) ? saldoPorNombre[n].toFixed(1) : '-';
    filas += '<tr><td>' + n + '</td><td style="text-align:right">' + det[n].toFixed(1) +
             '</td><td style="text-align:right">' + saldoAcumulado + '</td></tr>';
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
    to: jefeEmail(), cc: rrhhEmails(),
    subject: 'Resumen mensual de Horas Extra - ' + per,
    htmlBody: html
  });
}

// ==================== AUXILIARES ====================
/**
 * Busca una columna por nombre de encabezado. Lanza error claro si no
 * existe, en vez de romperse en silencio con un indice desactualizado.
 */
function _idx(encabezados, nombre) {
  const i = encabezados.indexOf(nombre);
  if (i === -1) throw new Error('No se encontro la columna "' + nombre + '" en los encabezados.');
  return i;
}

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

// ==================== WEBAPP PROPIA (futuro) ====================
/**
 * Incluye un archivo .html dentro de otro (partials de la WebApp propia
 * que reemplaza a AppSheet). Uso: <?!= include('nombre-del-archivo'); ?>
 */
function include(nombre) {
  return HtmlService.createHtmlOutputFromFile(nombre).getContent();
}
