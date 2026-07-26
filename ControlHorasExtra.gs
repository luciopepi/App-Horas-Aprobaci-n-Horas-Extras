/**
 * CONTROL DE HORAS EXTRA - SUPERVISORES
 * VSPT / Planta Graffigna
 *
 * INSTALACION:
 *  1. Crear un Google Sheet llamado DB_HorasExtra.
 *  2. Extensiones > Apps Script > pegar este codigo.
 *  3. Ejecutar setup() una vez (crea las 4 hojas y encabezados).
 *  4. Completar la hoja "Correos" con los correos reales del equipo
 *     (Email | Nombre | Rol | Activo). Roles validos: Supervisor,
 *     Jefe, Personas. Tiene que haber al menos un Jefe activo. La columna
 *     Linea NO va aca: un supervisor puede cubrir mas de una linea, asi
 *     que la linea se elige en cada solicitud (hoja Solicitudes), no
 *     queda fija por persona.
 *     IMPORTANTE: los correos NO van en el codigo ni en el repo, se
 *     cargan a mano en esta hoja.
 *  5. Crear los 2 Google Forms (horas extra y compensacion) y vincular
 *     sus respuestas a este Sheet.
 *  6. Implementar > Nueva implementacion > Aplicacion web
 *       Ejecutar como: YO
 *       Acceso: Cualquier usuario de <dominio de la empresa>
 *     El acceso por dominio (no "cualquier usuario") es lo que hace que
 *     Google bloquee el login de cuentas ajenas antes de cargar la app, y
 *     lo que hace que Session.getActiveUser().getEmail() devuelva el
 *     correo real de quien aprueba en vez de vacio.
 *     "Ejecutar como: YO" evita que cada usuario tenga que aceptar
 *     permisos y que necesite acceso al Sheet.
 *     Copiar la URL y pegarla en CONFIG.WEBAPP_URL.
 *  7. Activadores: onFormSubmitHE  -> Desde hoja de calculo / Al enviar formulario
 *                  resumenMensual  -> Basado en tiempo / Mensual dia 1, 07:00
 *
 * Si se edita la hoja "Correos" (alta, baja, cambio de rol o de activo),
 * correr invalidarCacheDirectorio() para que el cambio se refleje al toque
 * en jefeEmail(), personasEmails(), rolDe() y nombreDe(). Si no se corre, el
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
const COL_COR  = ['Email','Nombre','Rol','Activo'];

const ROLES_VALIDOS = ['Supervisor', 'Jefe', 'Personas'];

const CACHE_KEY_DIRECTORIO = 'directorio_correos';
const CACHE_TTL_DIRECTORIO = 300; // segundos

// ==================== NORMALIZACION ====================
/**
 * Normaliza un email para comparar y para usar como clave de mapa:
 * sin espacios y en minuscula. Usar SIEMPRE que se compare un email o
 * se use un email como clave (saldoSupervisor, tablaSaldos, _directorio,
 * validarCompensacion, rolDe, nombreDe). Sin esto, "Juan.Perez@x.com" y
 * "juan.perez@x.com" son dos personas distintas para el sistema.
 */
function _normEmail(x) {
  return String(x || '').trim().toLowerCase();
}

/**
 * Normaliza un rol a su forma canonica (Supervisor/Jefe/Personas), sin
 * importar mayusculas/minusculas. La validacion de datos de Sheets es
 * case-insensitive, asi que "jefe" tipeado a mano tiene que matchear
 * igual que "Jefe".
 *
 * El area se llama Gerencia de Personas, asi que el rol canonico es
 * "Personas". Se siguen aceptando "RRHH" y "Gestion de Personas" como
 * sinonimos para no romper planillas cargadas con la nomenclatura vieja.
 */
function _normRol(x) {
  const r = String(x || '').trim().toLowerCase();
  if (r === 'jefe') return 'Jefe';
  if (r === 'supervisor') return 'Supervisor';
  if (r === 'personas' || r === 'rrhh' ||
      r === 'gestion de personas' || r === 'gestión de personas' ||
      r === 'gerencia de personas') return 'Personas';
  return '';
}

/**
 * Detecta emails placeholder de ejemplo (dominios reservados por RFC 2606
 * que nunca deben resolver ni recibir correo real). Sirve para que el
 * sistema nunca mande el token de aprobacion a la fila de ejemplo si
 * alguien la deja con Activo=SI por error.
 */
function _esEmailPlaceholder(email) {
  const dominio = _normEmail(email).split('@')[1] || '';
  return dominio === 'invalid' || dominio === 'example' ||
         dominio.endsWith('.invalid') || dominio.endsWith('.example');
}

/** Genera un ID corto extra para evitar colisiones entre altas en el mismo segundo. */
function _sufijoId() {
  return Utilities.getUuid().slice(0, 4);
}

/**
 * Normaliza el titulo de una pregunta de formulario para poder compararlo
 * sin depender de tildes, mayusculas ni signos.
 *
 * Hace falta porque Google Forms usa el titulo EXACTO de la pregunta como
 * clave de e.namedValues, con tildes incluidas. El campo de email que
 * agrega Google cuando se activa "Recopilar direcciones de correo" se
 * llama "Direccion de correo electronico" CON tildes, asi que buscarlo
 * escrito sin tildes no encuentra nada y el email queda vacio. Sin email
 * no hay saldo: el sistema entero queda en cero sin dar ningun error.
 *
 * "Dirección de correo electrónico" y "direccion de correo electronico"
 * colapsan los dos a la misma clave.
 */
function _normClave(x) {
  return String(x || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Devuelve un lector de campos del formulario tolerante a como este
 * escrito el titulo de la pregunta. Acepta varios alias y devuelve el
 * primero que tenga contenido, o '' si ninguno matchea.
 *
 * Uso: const get = _lectorCampos(e.namedValues);
 *      get('Cantidad de horas', 'Horas')
 */
function _lectorCampos(namedValues) {
  const mapa = {};
  Object.keys(namedValues || {}).forEach(k => {
    mapa[_normClave(k)] = namedValues[k];
  });
  return function () {
    for (let i = 0; i < arguments.length; i++) {
      const v = mapa[_normClave(arguments[i])];
      if (v && v[0] && String(v[0]).trim()) return String(v[0]).trim();
    }
    return '';
  };
}

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
      .setFontWeight('bold').setBackground('#4E1742').setFontColor('#FFFFFF');
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
    // Fila de ejemplo con placeholder INVALIDO a proposito (dominio .invalid,
    // reservado por RFC 2606: nunca resuelve ni recibe correo) y Activo=NO.
    // Un dominio "de ejemplo" comun sin reservar es en realidad registrable:
    // si alguien dejaba ese placeholder sin reemplazar y Activo=SI, el
    // sistema le mandaba el nombre del supervisor, las horas, el motivo y
    // el LINK CON TOKEN VALIDO a un tercero. Reemplazar esta fila por el
    // correo real del Jefe y poner Activo=SI.
    sh.appendRow(['REEMPLAZAR@invalid', 'M. Rivas', 'Jefe', 'NO']);
  }
}

// ==================== DIRECTORIO (hoja Correos) ====================
/**
 * Devuelve el listado de personas activas de la hoja "Correos" como
 * array de {email, nombre, rol, activo}. Cachea el resultado
 * (scriptCache, 300s); si el cache falla, lee la hoja directamente.
 * No incluye Linea: un supervisor puede cubrir mas de una, asi que no
 * queda fija por persona en este directorio (ver Solicitudes.Linea).
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
  const cActivo = _idx(enc, 'Activo');

  const directorio = [];
  for (let i = 1; i < data.length; i++) {
    const fila = data[i];
    if (!fila[cEmail]) continue;
    if (String(fila[cActivo]).trim().toUpperCase() !== 'SI') continue;
    directorio.push({
      email:  _normEmail(fila[cEmail]),
      nombre: String(fila[cNombre]).trim(),
      rol:    _normRol(fila[cRol]),
      activo: 'SI'
    });
  }

  // No cachear un directorio vacio: si alguien deja todas las filas en
  // Activo=NO por error y despues lo corrige, no queremos que el sistema
  // siga "roto" hasta 5 minutos despues por un [] cacheado de mas.
  if (cache && directorio.length > 0) {
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
 * jefeEmail(), personasEmails(), rolDe() y nombreDe(). Sin esto, el cache
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
  if (!jefe || _esEmailPlaceholder(jefe.email)) {
    throw new Error('Completa la hoja "Correos" con el correo real del Jefe (rol Jefe, Activo=SI).');
  }
  return jefe.email;
}

/**
 * Correos de Gerencia de Personas (copia informativa y resumen mensual),
 * separados por coma. Puede devolver vacio si no hay nadie cargado con
 * ese rol: en ese caso quien llama debe omitir el cc, no mandarlo vacio.
 */
function personasEmails() {
  return _directorio()
    .filter(p => p.rol === 'Personas' && !_esEmailPlaceholder(p.email))
    .map(p => p.email)
    .join(',');
}

/**
 * Alias historico de personasEmails(). El rol se llamaba RRHH antes de
 * adoptar la nomenclatura del area (Gerencia de Personas). Se conserva
 * para no romper llamadas viejas.
 */
function rrhhEmails() {
  return personasEmails();
}

function rolDe(email) {
  const buscado = _normEmail(email);
  if (!buscado) return null;
  const persona = _directorio().find(p => p.email === buscado);
  return persona ? persona.rol : null;
}

function nombreDe(email) {
  const buscado = _normEmail(email);
  if (!buscado) return '';
  const persona = _directorio().find(p => p.email === buscado);
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
  const get = _lectorCampos(e.namedValues);

  if (hojaOrigen.indexOf('COMP') >= 0) {
    _altaCompensacion(get);
  } else {
    _altaHorasExtra(get);
  }
}

function _altaHorasExtra(get) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH.SOL);
  const id = 'HE-' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyMMdd-HHmmss') + '-' + _sufijoId();
  const token = Utilities.getUuid();

  const email      = get('Direccion de correo electronico', 'Email', 'Correo');
  // El nombre no se le pide al supervisor: sale del directorio a partir del
  // email verificado por Google. Un nombre tipeado a mano se escribe distinto
  // cada vez y ensucia el resumen mensual, que agrupa por nombre.
  const supervisor = get('Supervisor', 'Nombre') || nombreDe(email);
  const fechaHE    = get('Fecha de las horas extra', 'Fecha');
  const horas      = parseFloat(get('Cantidad de horas', 'Horas').replace(',', '.')) || 0;
  const linea      = get('Linea', 'Línea', 'Sector');
  const motivo     = get('Motivo');

  // Resolver el destinatario ANTES de escribir la fila: si no hay Jefe
  // configurado en la hoja "Correos", mejor que falle aca (nada se guarda)
  // a que quede una solicitud huerfana: escrita pero sin nadie que la
  // pueda ver ni aprobar.
  const destinatarioJefe = jefeEmail();

  sh.appendRow([id, new Date(), supervisor, email, fechaHE, horas, linea, motivo,
                'Pendiente', '', '', '', token]);

  _log(id, 'ALTA_HE', email, horas + ' hs - ' + fechaHE);

  try {
    MailApp.sendEmail({
      to: destinatarioJefe,
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
  } catch (err) {
    // La fila ya quedo guardada (arriba). Si el mail falla (cuota, etc.)
    // dejamos traza en Auditoria en vez de perder la solicitud en silencio.
    _log(id, 'ERROR_MAIL', email, 'No se pudo notificar al Jefe: ' + err.message);
  }
}

function _altaCompensacion(get) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH.COMP);
  const id = 'CP-' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyMMdd-HHmmss') + '-' + _sufijoId();
  const token = Utilities.getUuid();

  const email      = get('Direccion de correo electronico', 'Email', 'Correo');
  const supervisor = get('Supervisor', 'Nombre') || nombreDe(email);
  const fecha      = get('Fecha a compensar', 'Fecha solicitada', 'Fecha');
  const tipo       = get('Tipo') || 'Dia completo';
  let horas        = parseFloat(get('Horas a compensar').replace(',', '.'));
  if (!horas) horas = (tipo.toUpperCase().indexOf('MEDIO') >= 0)
                      ? CONFIG.HORAS_POR_DIA / 2 : CONFIG.HORAS_POR_DIA;

  const validacion = validarCompensacion(email, horas);

  // Resolver el destinatario ANTES de escribir la fila (ver _altaHorasExtra).
  const destinatarioJefe = jefeEmail();

  // IMPORTANTE (decision del director): el saldo insuficiente NO bloquea el
  // alta. La solicitud se guarda igual como Pendiente, con una alerta bien
  // visible en el mail para que el Jefe decida con criterio (por ejemplo,
  // adelantar un descanso a cuenta de horas futuras). Auto-rechazar le
  // sacaba la discrecion al Jefe y, combinado con un email mal escrito,
  // podia destruir solicitudes validas sin vuelta atras. El bloqueo
  // reversible (que SI corresponde) lo hace validarCompensacion() en el
  // submit de la futura WebApp, antes de que la solicitud llegue a existir.
  const alerta = !validacion.ok
    ? '<p style="background:#B00020;color:#fff;font-weight:bold;padding:10px 14px;' +
      'border-radius:4px;margin-bottom:16px">ATENCION: saldo insuficiente ' +
      '(saldo actual: ' + validacion.saldo.toFixed(1) + ' hs, solicitado ' +
      horas.toFixed(1) + ' hs). La solicitud quedo guardada igual como ' +
      'Pendiente: vos decidis si se aprueba.</p>'
    : '';

  sh.appendRow([id, new Date(), supervisor, email, fecha, horas, tipo,
                'Pendiente', '', '', '', token]);

  _log(id, 'ALTA_COMP', email, horas + ' hs - ' + fecha + (validacion.ok ? '' : ' [SALDO INSUFICIENTE]'));

  try {
    MailApp.sendEmail({
      to: destinatarioJefe,
      subject: (validacion.ok ? '' : '[SALDO INSUFICIENTE] ') + '[Compensacion Pendiente] ' + supervisor + ' - ' + fecha,
      htmlBody: alerta + _mailAprobacion({
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
  } catch (err) {
    _log(id, 'ERROR_MAIL', email, 'No se pudo notificar al Jefe: ' + err.message);
  }
}

// ==================== VALIDACION DE SALDO ====================
/**
 * Fuente de verdad unica para saber si una compensacion se puede otorgar.
 * En el alta por formulario (_altaCompensacion) es solo INFORMATIVA: si no
 * alcanza el saldo, la solicitud queda Pendiente igual con una alerta, y
 * el Jefe decide (ver comentario en _altaCompensacion). El BLOQUEO real y
 * reversible va en el submit de la futura WebApp propia, antes de que la
 * solicitud llegue a crearse. doGet tambien la usa para avisarle al Jefe
 * si el saldo cambio entre el alta y el momento de aprobar.
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

    if (p.accion !== 'aprobar' && p.accion !== 'rechazar') {
      return _html('Accion invalida.', '#B00020');
    }

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] !== p.id) continue;
      if (String(data[i][cTok]) !== p.token) return _html('Token invalido.', '#B00020');
      if (data[i][cEst] !== 'Pendiente')
        return _html('Esta solicitud ya fue procesada (' + data[i][cEst] + ').', '#8A6D00');

      const estado = (p.accion === 'aprobar') ? 'Aprobada' : 'Rechazada';

      // Quien esta actuando. Si Google no informa un usuario (normal cuando
      // el Jefe abre el link del mail en el celular sin sesion de
      // Workspace activa), no le atribuimos la accion a nadie en concreto.
      // Si SI informa un usuario, tiene que figurar como Jefe en la hoja
      // "Correos" para poder aprobar o rechazar.
      let quien = Session.getActiveUser().getEmail();
      if (quien) {
        if (rolDe(quien) !== 'Jefe') {
          return _html('Tu cuenta (' + quien + ') no tiene permiso de Jefe para aprobar o rechazar solicitudes.', '#B00020');
        }
      } else {
        quien = 'Desconocido (via token)';
      }

      // Compensaciones: si el saldo ya no alcanza (pudo cambiar desde el
      // alta), no rechazamos solo: le pedimos al Jefe que confirme la
      // aprobacion a sabiendas, con un segundo click.
      let saldoNegativoConfirmado = false;
      if (esComp && estado === 'Aprobada') {
        const validacion = validarCompensacion(data[i][cEmail], parseFloat(data[i][cHoras]) || 0);
        if (!validacion.ok) {
          if (p.confirmar !== '1') {
            const urlConfirmar = CONFIG.WEBAPP_URL + '?id=' + encodeURIComponent(p.id) +
              '&token=' + encodeURIComponent(p.token) + '&accion=aprobar&confirmar=1';
            return HtmlService.createHtmlOutput(
              '<div style="font-family:Arial,sans-serif;text-align:center;padding:48px 24px;max-width:480px;margin:0 auto">' +
              '<p style="font-size:18px;color:#B00020;font-weight:bold">Saldo insuficiente</p>' +
              '<p style="font-size:15px;color:#333">' + validacion.mensaje + '</p>' +
              '<p style="font-size:14px;color:#666">Si de todos modos queres aprobarla, confirma la aprobacion:</p>' +
              '<p><a href="' + urlConfirmar + '" style="background:#B00020;color:#fff;padding:12px 28px;' +
              'text-decoration:none;border-radius:4px;font-weight:bold">APROBAR IGUAL</a></p>' +
              '<p style="font-size:12px;color:#999">Si no confirmas, la solicitud sigue Pendiente sin cambios.</p>' +
              '</div>'
            ).addMetaTag('viewport', 'width=device-width, initial-scale=1');
          }
          saldoNegativoConfirmado = true;
        }
      }

      sh.getRange(i + 1, cEst + 1).setValue(estado);
      sh.getRange(i + 1, cApr + 1).setValue(quien);
      sh.getRange(i + 1, cFec + 1).setValue(new Date());

      _log(p.id, estado.toUpperCase(), quien, '');
      if (saldoNegativoConfirmado) {
        _log(p.id, 'APROBADA_SALDO_NEGATIVO', quien, 'Aprobada con saldo insuficiente, confirmado explicitamente por el Jefe.');
      }
      _notificarResultado(data[i], estado, esComp, enc);

      return _html('Solicitud ' + p.id + ' <b>' + estado + '</b>.',
                   estado === 'Aprobada' ? '#1B7F4B' : '#B00020');
    }
    return _html('No se encontro la solicitud.', '#B00020');
  } finally {
    lock.releaseLock();
  }
}

function _notificarResultado(fila, estado, esComp, enc) {
  const cSupervisor = _idx(enc, 'Supervisor');
  const cEmail      = _idx(enc, 'Email');
  const cFecha      = _idx(enc, esComp ? 'Fecha solicitada' : 'Fecha HE');
  const cHoras      = _idx(enc, esComp ? 'Horas a compensar' : 'Horas');

  const supervisor = fila[cSupervisor], email = fila[cEmail], fecha = fila[cFecha], horas = fila[cHoras];
  const asunto = (esComp ? '[Compensacion ' : '[Horas Extra ') + estado + '] ' + fecha;
  const cuerpo =
    '<p>Hola ' + supervisor + ',</p>' +
    '<p>Tu solicitud del <b>' + fecha + '</b> (' + horas + ' hs) fue <b>' +
    estado.toLowerCase() + '</b>.</p>' +
    '<p>Saldo actual de horas extra: <b>' + saldoSupervisor(email).toFixed(1) + ' hs</b>.</p>' +
    '<p style="font-size:11px;color:#777">' + CONFIG.NOMBRE_PLANTA + '</p>';

  const opciones = { to: email, subject: asunto, htmlBody: cuerpo };
  const cc = personasEmails();
  if (cc) opciones.cc = cc;
  MailApp.sendEmail(opciones);
}

// ==================== SALDOS ====================
function saldoSupervisor(email) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const buscado = _normEmail(email);
  let saldo = 0;
  const acum = (hoja, signo) => {
    const d = ss.getSheetByName(hoja).getDataRange().getValues();
    if (d.length < 2) return;
    const enc = d[0];
    const cEmail  = _idx(enc, 'Email');
    const cEstado = _idx(enc, 'Estado');
    const cHoras  = _idx(enc, hoja === SH.SOL ? 'Horas' : 'Horas a compensar');
    for (let i = 1; i < d.length; i++)
      if (_normEmail(d[i][cEmail]) === buscado && d[i][cEstado] === 'Aprobada')
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
      const k = _normEmail(d[i][cEmail]);
      if (!k) continue;
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

  const opciones = { to: jefeEmail(), subject: 'Resumen mensual de Horas Extra - ' + per, htmlBody: html };
  const cc = personasEmails();
  if (cc) opciones.cc = cc;
  MailApp.sendEmail(opciones);
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
