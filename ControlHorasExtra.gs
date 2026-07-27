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
 *  6. Crear ademas 3 archivos HTML en el mismo proyecto de Apps Script
 *     (Archivo > Nuevo > Archivo HTML), con estos nombres EXACTOS, y
 *     pegarles el contenido de webapp/Index.html, webapp/Estilos.html y
 *     webapp/JsApp.html del repo (Apps Script no tiene subcarpetas: los
 *     archivos van sueltos, la carpeta "webapp/" es solo organizacion del
 *     repo):
 *       - Index.html
 *       - Estilos.html
 *       - JsApp.html
 *  7. Implementar > Nueva implementacion > Aplicacion web
 *       Ejecutar como: YO
 *       Acceso: Cualquier usuario de <dominio de la empresa>
 *     El acceso por dominio (no "cualquier usuario") es lo que hace que
 *     Google bloquee el login de cuentas ajenas antes de cargar la app, y
 *     lo que hace que Session.getActiveUser().getEmail() devuelva el
 *     correo real de quien aprueba en vez de vacio.
 *     "Ejecutar como: YO" evita que cada usuario tenga que aceptar
 *     permisos y que necesite acceso al Sheet.
 *     Copiar la URL y pegarla en CONFIG.WEBAPP_URL. Esa misma URL, abierta
 *     sin parametros, es la WebApp (doGet la sirve). Con id+token+accion
 *     en la URL (los botones del mail) sigue siendo el flujo de aprobacion
 *     de siempre.
 *  8. Activadores: onFormSubmitHE  -> Desde hoja de calculo / Al enviar formulario
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
  TZ:            'America/Argentina/San_Juan',

  // Icono de la app: es el que usa Chrome para el acceso directo que queda
  // en la pantalla del celular. Si queda vacio, Android muestra uno
  // generico y la app funciona igual.
  // Tiene que ser una URL PUBLICA a una imagen; Apps Script no acepta data
  // URI aca. Para obtenerla: subir el PNG a Drive, compartirlo como
  // "cualquier persona con el enlace" y armar el enlace directo con el ID
  // del archivo. Pendiente: definir el icono a partir del logo
  // institucional (ver README, seccion "Icono").
  ICONO_URL:     ''
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
 * Formatea una fecha para mostrarla en un mail o pantalla. El formulario
 * manda la fecha como texto, pero Sheets suele interpretar esa celda como
 * fecha real; al releerla con getValues() vuelve como objeto Date, y
 * concatenarla cruda a un string tira el toString() completo
 * ("Sun Jul 26 2026 00:00:00 GMT-0300 (hora estandar de Argentina)").
 * Si el valor es Date, se formatea; si no, se devuelve el texto tal cual.
 */
function _fmtFecha(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, CONFIG.TZ, 'dd/MM/yyyy');
  }
  return String(v || '').trim();
}

/**
 * Formatea una cantidad de horas para texto: sin arrastre de coma flotante
 * (2.0000000001 -> "2"), sin decimales si es un numero entero, con coma
 * como separador si no. Redondea a 2 decimales antes de decidir el formato.
 * OJO: es solo para TEXTO (mail, log). El valor numerico que se guarda en
 * la planilla y se usa para sumar saldo sigue siendo el numero crudo.
 */
function _fmtHoras(n) {
  const num = Math.round((parseFloat(n) || 0) * 100) / 100;
  if (Number.isInteger(num)) return String(num);
  return String(num).replace('.', ',');
}

/**
 * Identifica al usuario actual por su sesion de Google — NUNCA por datos
 * que mande el cliente — y valida que tenga uno de los roles permitidos.
 * Es el unico punto de entrada de autorizacion de toda la API de la
 * WebApp: toda funcion expuesta a google.script.run tiene que arrancar
 * llamando a esto. Cortar aca es cortar en todos lados.
 *
 * @param {string[]} [rolesPermitidos] si se pasa, exige ademas que el rol
 *   este en esa lista; si se omite, alcanza con estar identificado.
 * @returns {{email:string, nombre:string, rol:string}}
 */
function _identificar(rolesPermitidos) {
  const yo = _normEmail(Session.getActiveUser().getEmail());
  if (!yo) throw new Error('No se pudo identificar tu cuenta. Ingresa con tu cuenta de la empresa.');
  const rol = rolDe(yo);
  if (!rol) throw new Error('Tu cuenta no esta habilitada. Pedi que te agreguen al directorio.');
  if (rolesPermitidos && rolesPermitidos.indexOf(rol) === -1) {
    throw new Error('Tu rol (' + rol + ') no tiene permiso para esta accion.');
  }
  return { email: yo, nombre: nombreDe(yo), rol: rol };
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
  const email      = get('Direccion de correo electronico', 'Email', 'Correo');
  // El nombre no se le pide al supervisor: sale del directorio a partir del
  // email verificado por Google. Un nombre tipeado a mano se escribe distinto
  // cada vez y ensucia el resumen mensual, que agrupa por nombre.
  const supervisor = get('Supervisor', 'Nombre') || nombreDe(email);
  const fechaHE    = get('Fecha de las horas extra', 'Fecha');
  const horas      = parseFloat(get('Cantidad de horas', 'Horas').replace(',', '.')) || 0;
  const linea      = get('Linea', 'Línea', 'Sector');
  const motivo     = get('Motivo');

  _crearHoraExtra({ supervisor: supervisor, email: email, fecha: fechaHE,
                     horas: horas, linea: linea, motivo: motivo });
}

/**
 * Nucleo de alta de horas extra: escribe la fila en Solicitudes, loguea y
 * notifica al Jefe. Es la UNICA fuente de verdad del alta — la usan tanto
 * el formulario (_altaHorasExtra, arriba) como la API de la WebApp
 * (apiCrearHoraExtra, mas abajo). No duplicar esta logica en otro lado.
 *
 * @param {{supervisor:string, email:string, fecha:(string|Date), horas:number, linea:string, motivo:string}} datos
 * @returns {{id:string}}
 */
function _crearHoraExtra(datos) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH.SOL);
  const id = 'HE-' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyMMdd-HHmmss') + '-' + _sufijoId();
  const token = Utilities.getUuid();

  const supervisor = datos.supervisor;
  const email       = datos.email;
  const fecha       = datos.fecha;           // Date real (API) o texto (form): se guarda tal cual
  const horas       = parseFloat(datos.horas) || 0;
  const linea       = datos.linea;
  const motivo      = datos.motivo;
  const fechaTexto  = _fmtFecha(fecha);
  const horasTexto  = _fmtHoras(horas);

  // Resolver el destinatario ANTES de escribir la fila: si no hay Jefe
  // configurado en la hoja "Correos", mejor que falle aca (nada se guarda)
  // a que quede una solicitud huerfana: escrita pero sin nadie que la
  // pueda ver ni aprobar.
  const destinatarioJefe = jefeEmail();

  sh.appendRow([id, new Date(), supervisor, email, fecha, horas, linea, motivo,
                'Pendiente', '', '', '', token]);

  _log(id, 'ALTA_HE', email, horasTexto + ' hs - ' + fechaTexto);

  try {
    MailApp.sendEmail({
      to: destinatarioJefe,
      subject: '[HE Pendiente] ' + supervisor + ' - ' + horasTexto + ' hs - ' + fechaTexto,
      htmlBody: _mailAprobacion({
        titulo: 'Solicitud de Horas Extra',
        id: id, token: token, tipo: 'HE',
        filas: [
          ['Supervisor', supervisor],
          ['Fecha HE', fechaTexto],
          ['Horas', horasTexto],
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

  return { id: id };
}

function _altaCompensacion(get) {
  const email      = get('Direccion de correo electronico', 'Email', 'Correo');
  const supervisor = get('Supervisor', 'Nombre') || nombreDe(email);
  const fecha      = get('Fecha a compensar', 'Fecha solicitada', 'Fecha');
  const tipo       = get('Tipo') || 'Dia completo';
  const horas      = parseFloat(get('Horas a compensar').replace(',', '.'));

  _crearCompensacion({ supervisor: supervisor, email: email, fecha: fecha,
                        tipo: tipo, horas: horas });
}

/**
 * Nucleo de alta de compensacion: escribe la fila en Compensaciones,
 * loguea y notifica al Jefe. Es la UNICA fuente de verdad del alta — la
 * usan tanto el formulario (_altaCompensacion, arriba) como la API de la
 * WebApp (apiCrearCompensacion, mas abajo). No duplicar esta logica.
 *
 * IMPORTANTE (decision del director): el saldo insuficiente NO bloquea
 * este alta. La solicitud se guarda igual como Pendiente, con una alerta
 * bien visible en el mail para que el Jefe decida con criterio (por
 * ejemplo, adelantar un descanso a cuenta de horas futuras). Auto-rechazar
 * le sacaba la discrecion al Jefe y, combinado con un email mal escrito,
 * podia destruir solicitudes validas sin vuelta atras. El bloqueo
 * reversible (que SI corresponde aca) lo hace apiCrearCompensacion() en la
 * WebApp, ANTES de llamar a esta funcion — ver comentario alla.
 *
 * @param {{supervisor:string, email:string, fecha:(string|Date), tipo:string, horas:number}} datos
 * @returns {{id:string, saldoOk:boolean}}
 */
function _crearCompensacion(datos) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH.COMP);
  const id = 'CP-' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyMMdd-HHmmss') + '-' + _sufijoId();
  const token = Utilities.getUuid();

  const supervisor = datos.supervisor;
  const email = datos.email;
  const fecha = datos.fecha;
  const tipo = datos.tipo || 'Dia completo';
  let horas = parseFloat(datos.horas);
  if (!horas) horas = (String(tipo).toUpperCase().indexOf('MEDIO') >= 0)
                      ? CONFIG.HORAS_POR_DIA / 2 : CONFIG.HORAS_POR_DIA;

  const fechaTexto = _fmtFecha(fecha);
  const validacion = validarCompensacion(email, horas);

  // Resolver el destinatario ANTES de escribir la fila (ver _crearHoraExtra).
  const destinatarioJefe = jefeEmail();

  const alerta = !validacion.ok
    ? '<p style="background:#B00020;color:#fff;font-weight:bold;padding:10px 14px;' +
      'border-radius:4px;margin-bottom:16px">ATENCION: saldo insuficiente ' +
      '(saldo actual: ' + _fmtHoras(validacion.saldo) + ' hs, solicitado ' +
      _fmtHoras(horas) + ' hs). La solicitud quedo guardada igual como ' +
      'Pendiente: vos decidis si se aprueba.</p>'
    : '';

  sh.appendRow([id, new Date(), supervisor, email, fecha, horas, tipo,
                'Pendiente', '', '', '', token]);

  _log(id, 'ALTA_COMP', email, _fmtHoras(horas) + ' hs - ' + fechaTexto + (validacion.ok ? '' : ' [SALDO INSUFICIENTE]'));

  try {
    MailApp.sendEmail({
      to: destinatarioJefe,
      subject: (validacion.ok ? '' : '[SALDO INSUFICIENTE] ') + '[Compensacion Pendiente] ' + supervisor + ' - ' + fechaTexto,
      htmlBody: alerta + _mailAprobacion({
        titulo: 'Solicitud de Compensacion',
        id: id, token: token, tipo: 'CP',
        filas: [
          ['Supervisor', supervisor],
          ['Fecha solicitada', fechaTexto],
          ['Tipo', tipo],
          ['Horas a descontar', _fmtHoras(horas)],
          ['Saldo disponible', _fmtHoras(validacion.saldo) + ' hs']
        ]
      })
    });
  } catch (err) {
    _log(id, 'ERROR_MAIL', email, 'No se pudo notificar al Jefe: ' + err.message);
  }

  return { id: id, saldoOk: validacion.ok };
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
      mensaje: 'Saldo insuficiente: disponible ' + _fmtHoras(saldo) +
               ' hs, solicitado ' + _fmtHoras(horasNum) + ' hs.'
    };
  }
  return { ok: true, saldo: saldo, mensaje: 'Saldo suficiente.' };
}

// ==================== WEB APP ====================
/**
 * doGet tiene DOS trabajos, ruteados por los parametros de la URL:
 *
 *  - CON id+token+accion: es el click en un boton APROBAR/RECHAZAR del
 *    mail. Todo el bloque de aca abajo (lock, idempotencia, validacion de
 *    accion, confirmacion de saldo negativo) esta EN PRODUCCION y no se
 *    toca: solo se le aplico el fix de formato de fecha (dentro de
 *    _notificarResultado, que ya usaba antes de este cambio).
 *
 *  - SIN esos tres parametros: no es un click desde el mail, se sirve la
 *    WebApp real (la que usan los supervisores/Jefe/Personas a diario).
 */
function doGet(e) {
  const p = e.parameter;

  if (!p.id || !p.token || !p.accion) {
    const pagina = HtmlService.createTemplateFromFile('Index')
      .evaluate()
      // El titulo es el nombre que Android le propone al acceso directo
      // cuando lo agregan a la pantalla de inicio. Corto a proposito: los
      // nombres largos se truncan con puntos suspensivos abajo del icono.
      .setTitle('Horas Extra')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

    // Solo si hay un icono cargado: pasar una URL vacia o invalida deja el
    // acceso directo con un icono roto, que es peor que el generico.
    if (CONFIG.ICONO_URL) pagina.setFaviconUrl(CONFIG.ICONO_URL);

    return pagina;
  }

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

  const supervisor = fila[cSupervisor], email = fila[cEmail];
  const fecha = _fmtFecha(fila[cFecha]);
  const horas = _fmtHoras(fila[cHoras]);
  const asunto = (esComp ? '[Compensacion ' : '[Horas Extra ') + estado + '] ' + fecha;
  const cuerpo =
    '<p>Hola ' + supervisor + ',</p>' +
    '<p>Tu solicitud del <b>' + fecha + '</b> (' + horas + ' hs) fue <b>' +
    estado.toLowerCase() + '</b>.</p>' +
    '<p>Saldo actual de horas extra: <b>' + _fmtHoras(saldoSupervisor(email)) + ' hs</b>.</p>' +
    '<p style="font-size:11px;color:#777">' + CONFIG.NOMBRE_PLANTA + '</p>';

  const opciones = { to: email, subject: asunto, htmlBody: cuerpo };
  const cc = personasEmails();
  if (cc) opciones.cc = cc;
  MailApp.sendEmail(opciones);
}

// ==================== SALDOS ====================
/**
 * Suma las horas Aprobadas de UNA hoja (Solicitudes o Compensaciones) para
 * un email. Bloque comun de saldoSupervisor() y de la API (apiEstado,
 * _equipoCompleto): antes esta suma estaba duplicada como closure dentro
 * de saldoSupervisor(); se extrajo aca para no repetirla.
 */
function _sumaAprobadas(hoja, email) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const buscado = _normEmail(email);
  const d = ss.getSheetByName(hoja).getDataRange().getValues();
  if (d.length < 2) return 0;
  const enc = d[0];
  const cEmail  = _idx(enc, 'Email');
  const cEstado = _idx(enc, 'Estado');
  const cHoras  = _idx(enc, hoja === SH.SOL ? 'Horas' : 'Horas a compensar');
  let total = 0;
  for (let i = 1; i < d.length; i++) {
    if (_normEmail(d[i][cEmail]) === buscado && d[i][cEstado] === 'Aprobada') {
      total += parseFloat(d[i][cHoras]) || 0;
    }
  }
  return total;
}

function saldoSupervisor(email) {
  return _sumaAprobadas(SH.SOL, email) - _sumaAprobadas(SH.COMP, email);
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
    const saldoAcumulado = saldoPorNombre.hasOwnProperty(n) ? _fmtHoras(saldoPorNombre[n]) : '-';
    filas += '<tr><td>' + n + '</td><td style="text-align:right">' + _fmtHoras(det[n]) +
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
    '<td align="right">' + _fmtHoras(total) + '</td><td></td></tr></table>' +
    (pend ? '<p style="color:#B00020">Solicitudes pendientes de aprobacion: ' + pend + '</p>' : '') +
    '</div>';

  const opciones = { to: jefeEmail(), subject: 'Resumen mensual de Horas Extra - ' + per, htmlBody: html };
  const cc = personasEmails();
  if (cc) opciones.cc = cc;
  MailApp.sendEmail(opciones);
}

// ==================== API DE LA WEBAPP (google.script.run) ====================
/**
 * CRITICO DE SEGURIDAD: la WebApp corre con executeAs=USER_DEPLOYING y
 * access=DOMAIN. El script tiene permisos totales sobre el Sheet sin
 * importar quien este del otro lado. Por eso TODA funcion expuesta ac
 * abajo arranca llamando a _identificar(), que resuelve el rol por la
 * SESION de Google (nunca por un parametro que mande el cliente), y
 * ademas cada lectura se filtra en el SERVIDOR por ese email/rol. El
 * cliente nunca decide que datos le corresponden ver ni que puede hacer.
 */

/**
 * Filas de una hoja (Solicitudes o Compensaciones) que pertenecen a un
 * email, como objetos {NombreDeColumna: valor}. Filtra siempre en el
 * SERVIDOR: se usa para que un Supervisor solo pueda ver lo suyo.
 */
function _filasDe(hoja, email) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const buscado = _normEmail(email);
  const d = ss.getSheetByName(hoja).getDataRange().getValues();
  if (d.length < 2) return [];
  const enc = d[0];
  const cEmail = _idx(enc, 'Email');
  const filas = [];
  for (let i = 1; i < d.length; i++) {
    if (_normEmail(d[i][cEmail]) !== buscado) continue;
    const obj = {};
    enc.forEach(function (nombreCol, c) { obj[nombreCol] = d[i][c]; });
    filas.push(obj);
  }
  return filas;
}

/** HE aprobadas de un email dentro del mes calendario en curso (para el KPI "HE del mes"). */
function _heDelMes(email) {
  const hoy = new Date();
  const ini = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0, 23, 59, 59);
  const buscado = _normEmail(email);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const d = ss.getSheetByName(SH.SOL).getDataRange().getValues();
  if (d.length < 2) return 0;
  const enc = d[0];
  const cEmail = _idx(enc, 'Email');
  const cEstado = _idx(enc, 'Estado');
  const cHoras = _idx(enc, 'Horas');
  const cTimestamp = _idx(enc, 'Timestamp');
  let total = 0;
  for (let i = 1; i < d.length; i++) {
    if (_normEmail(d[i][cEmail]) !== buscado) continue;
    if (d[i][cEstado] !== 'Aprobada') continue;
    const ts = new Date(d[i][cTimestamp]);
    if (ts < ini || ts > fin) continue;
    total += parseFloat(d[i][cHoras]) || 0;
  }
  return total;
}

/** Todas las solicitudes Pendientes (HE y Compensacion) para la bandeja del Jefe. */
function _pendientesParaJefe() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lista = [];

  const sol = ss.getSheetByName(SH.SOL).getDataRange().getValues();
  if (sol.length >= 2) {
    const enc = sol[0];
    const cId = _idx(enc, 'ID'), cSup = _idx(enc, 'Supervisor'), cEmail = _idx(enc, 'Email'),
          cFecha = _idx(enc, 'Fecha HE'), cHoras = _idx(enc, 'Horas'), cLinea = _idx(enc, 'Linea'),
          cMotivo = _idx(enc, 'Motivo'), cEstado = _idx(enc, 'Estado');
    for (let i = 1; i < sol.length; i++) {
      if (sol[i][cEstado] !== 'Pendiente') continue;
      lista.push({
        id: sol[i][cId], tipo: 'HE', nombre: sol[i][cSup], email: _normEmail(sol[i][cEmail]),
        fecha: _fmtFecha(sol[i][cFecha]), horas: parseFloat(sol[i][cHoras]) || 0,
        linea: sol[i][cLinea], motivo: sol[i][cMotivo]
      });
    }
  }

  const comp = ss.getSheetByName(SH.COMP).getDataRange().getValues();
  if (comp.length >= 2) {
    const enc = comp[0];
    const cId = _idx(enc, 'ID'), cSup = _idx(enc, 'Supervisor'), cEmail = _idx(enc, 'Email'),
          cFecha = _idx(enc, 'Fecha solicitada'), cHoras = _idx(enc, 'Horas a compensar'),
          cTipo = _idx(enc, 'Tipo'), cEstado = _idx(enc, 'Estado');
    for (let i = 1; i < comp.length; i++) {
      if (comp[i][cEstado] !== 'Pendiente') continue;
      lista.push({
        id: comp[i][cId], tipo: 'CP', nombre: comp[i][cSup], email: _normEmail(comp[i][cEmail]),
        fecha: _fmtFecha(comp[i][cFecha]), horas: parseFloat(comp[i][cHoras]) || 0,
        linea: '-', motivo: 'Compensacion - ' + comp[i][cTipo]
      });
    }
  }

  lista.sort(function (a, b) { return a.id < b.id ? 1 : -1; }); // mas nuevo primero (el ID trae fecha-hora)
  return lista;
}

/** Saldo/HE-del-mes de todos los Supervisores activos del directorio, para las vistas de Jefe y Personas. */
function _equipoCompleto() {
  return _directorio()
    .filter(function (p) { return p.rol === 'Supervisor'; })
    .map(function (p) {
      const generadas = _sumaAprobadas(SH.SOL, p.email);
      const compensadas = _sumaAprobadas(SH.COMP, p.email);
      return {
        nombre: p.nombre,
        email: p.email,
        generadas: generadas,
        compensadas: compensadas,
        saldo: generadas - compensadas,
        heDelMes: _heDelMes(p.email)
      };
    })
    .sort(function (a, b) { return b.saldo - a.saldo; });
}

/** Convierte "yyyy-mm-dd" (lo que manda un <input type="date">) a un Date real. */
function _parsearFechaInput(valor) {
  const s = String(valor || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('Fecha invalida.');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) throw new Error('Fecha invalida.');
  return d;
}

function _validarFechaNoFutura(fecha) {
  const finDeHoy = new Date();
  finDeHoy.setHours(23, 59, 59, 999);
  if (fecha.getTime() > finDeHoy.getTime()) {
    throw new Error('La fecha de las horas extra no puede ser futura.');
  }
}

/**
 * Estado completo para la pantalla principal de la WebApp. Los datos que
 * devuelve dependen del rol de quien pregunta (resuelto por sesion, no por
 * el cliente): un Supervisor jamas recibe datos de otro supervisor.
 */
function apiEstado() {
  const yo = _identificar();
  const resultado = { yo: yo };

  // Los datos propios se calculan para CUALQUIER rol, no solo Supervisor.
  // Un Jefe tambien puede cargar horas extra (apiCrearHoraExtra se lo
  // permite), y si no le devolvieramos su saldo cargaria horas que despues
  // no ve por ningun lado. No hay riesgo de privacidad: son sus propios
  // datos, filtrados por el email de su sesion.
  const generadas = _sumaAprobadas(SH.SOL, yo.email);
  const compensadas = _sumaAprobadas(SH.COMP, yo.email);

  resultado.misSolicitudes = _filasDe(SH.SOL, yo.email).map(function (f) {
    return {
      id: f.ID, fecha: _fmtFecha(f['Fecha HE']), horas: parseFloat(f.Horas) || 0,
      linea: f.Linea, motivo: f.Motivo, estado: f.Estado
    };
  }).sort(function (a, b) { return a.id < b.id ? 1 : -1; });

  resultado.misCompensaciones = _filasDe(SH.COMP, yo.email).map(function (f) {
    return {
      id: f.ID, fecha: _fmtFecha(f['Fecha solicitada']), horas: parseFloat(f['Horas a compensar']) || 0,
      tipo: f.Tipo, estado: f.Estado
    };
  }).sort(function (a, b) { return a.id < b.id ? 1 : -1; });

  resultado.saldo = { generadas: generadas, compensadas: compensadas, disponible: generadas - compensadas };

  // El bloque personal se muestra siempre a los Supervisores (aunque este
  // en cero: es su pantalla principal) y, para los demas roles, solo si
  // tienen actividad real. Asi Gerencia de Personas no ve un saldo vacio
  // que no le corresponde, pero el Jefe si ve el suyo cuando carga horas.
  resultado.mostrarPanelPersonal = (yo.rol === 'Supervisor') ||
    resultado.misSolicitudes.length > 0 || resultado.misCompensaciones.length > 0;

  let pendientesCompletos = null;
  if (yo.rol === 'Jefe') {
    pendientesCompletos = _pendientesParaJefe();
    resultado.pendientes = pendientesCompletos;
  }

  if (yo.rol === 'Jefe' || yo.rol === 'Personas') {
    const equipo = _equipoCompleto();
    if (!pendientesCompletos) pendientesCompletos = _pendientesParaJefe();
    resultado.equipo = equipo;
    resultado.totales = {
      heDelMes: equipo.reduce(function (acc, p) { return acc + p.heDelMes; }, 0),
      pendientes: pendientesCompletos.length,
      saldoTotal: equipo.reduce(function (acc, p) { return acc + p.saldo; }, 0)
    };
  }

  return resultado;
}

/**
 * Alta de horas extra desde la WebApp. Rol Supervisor o Jefe. El email
 * SIEMPRE es el de la sesion (yo.email) — nunca uno que mande el cliente.
 * Reutiliza _crearHoraExtra(), el mismo nucleo que usa el formulario, asi
 * que el ID, el token, el log de Auditoria y el mail al Jefe salen
 * identicos por los dos caminos.
 */
function apiCrearHoraExtra(payload) {
  const yo = _identificar(['Supervisor', 'Jefe']);
  payload = payload || {};

  const fecha = _parsearFechaInput(payload.fecha);
  _validarFechaNoFutura(fecha);

  const horas = parseFloat(String(payload.horas == null ? '' : payload.horas).replace(',', '.'));
  if (!horas || horas < 0.5 || horas > 24) {
    throw new Error('La cantidad de horas tiene que ser un numero entre 0,5 y 24.');
  }

  const linea = String(payload.linea || '').trim();
  if (['L1', 'L2', 'L3', 'Varias'].indexOf(linea) === -1) {
    throw new Error('Linea invalida: elegi L1, L2, L3 o Varias.');
  }

  const motivo = String(payload.motivo || '').trim();
  if (!motivo) throw new Error('El motivo no puede estar vacio.');

  const r = _crearHoraExtra({
    supervisor: yo.nombre, email: yo.email, fecha: fecha,
    horas: horas, linea: linea, motivo: motivo
  });
  return { ok: true, id: r.id };
}

/**
 * Alta de compensacion desde la WebApp. Rol Supervisor o Jefe.
 *
 * ACA SI SE BLOQUEA POR SALDO — es el UNICO lugar donde corresponde,
 * porque es reversible: el usuario ve el error, corrige y reenvia, no se
 * pierde nada. El alta por FORMULARIO (_altaCompensacion/_crearCompensacion)
 * sigue sin bloquear a proposito: son dos caminos con reglas distintas,
 * no se unifican (ver comentario en _crearCompensacion).
 *
 * El tipo lo manda el cliente pero las HORAS las calcula el SERVIDOR a
 * partir del tipo (nunca confiamos en un numero de horas que mande el
 * cliente para esto: dejaria manipular el saldo con un payload armado a
 * mano).
 */
function apiCrearCompensacion(payload) {
  const yo = _identificar(['Supervisor', 'Jefe']);
  payload = payload || {};

  const fecha = _parsearFechaInput(payload.fecha);

  const tipoCrudo = String(payload.tipo || '').trim().toLowerCase();
  let tipo, horas;
  if (tipoCrudo === 'medio') {
    tipo = 'Medio dia';
    horas = CONFIG.HORAS_POR_DIA / 2;
  } else if (tipoCrudo === 'completo') {
    tipo = 'Dia completo';
    horas = CONFIG.HORAS_POR_DIA;
  } else {
    throw new Error('Tipo de compensacion invalido.');
  }

  const validacion = validarCompensacion(yo.email, horas);
  if (!validacion.ok) {
    throw new Error(validacion.mensaje);
  }

  const r = _crearCompensacion({
    supervisor: yo.nombre, email: yo.email, fecha: fecha, tipo: tipo, horas: horas
  });
  return { ok: true, id: r.id };
}

/**
 * Aprueba o rechaza una solicitud desde la WebApp. SOLO rol Jefe.
 * Mismas garantias que el flujo de doGet (que no se toca): LockService,
 * idempotencia, registro en Auditoria con el email real (de la sesion,
 * nunca del cliente) y mail de resultado al supervisor con copia a
 * Personas. Es una implementacion INDEPENDIENTE de la de doGet a
 * proposito: doGet identifica al Jefe por un link con token publico (a
 * veces sin sesion), esta funcion siempre tiene sesion real porque
 * google.script.run no funciona sin ella. Compartir codigo entre las dos
 * hubiera significado tocar el doGet que esta en produccion.
 *
 * @param {string} id
 * @param {string} accion 'aprobar' | 'rechazar'
 * @param {boolean} [confirmar] solo compensaciones con saldo insuficiente:
 *   hace falta un segundo llamado con confirmar=true para aprobar "en
 *   descubierto". Sin eso, devuelve {ok:false, requiereConfirmacion:true}.
 */
function apiResolver(id, accion, confirmar) {
  const yo = _identificar(['Jefe']);

  id = String(id || '');
  if (!id) throw new Error('Falta el ID de la solicitud.');
  if (accion !== 'aprobar' && accion !== 'rechazar') {
    throw new Error('Accion invalida.');
  }

  const lock = LockService.getScriptLock();
  let tieneLock = false;
  try {
    tieneLock = lock.tryLock(10000);
  } catch (err) {
    tieneLock = false;
  }
  if (!tieneLock) {
    throw new Error('El sistema esta ocupado procesando otra solicitud. Intenta de nuevo en unos segundos.');
  }

  try {
    const esComp = id.indexOf('CP-') === 0;
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(esComp ? SH.COMP : SH.SOL);
    const data = sh.getDataRange().getValues();
    if (data.length < 2) throw new Error('No se encontro la solicitud.');

    const enc = data[0];
    const cId    = _idx(enc, 'ID');
    const cEst   = _idx(enc, 'Estado');
    const cApr   = _idx(enc, 'Aprobado por');
    const cFec   = _idx(enc, 'Fecha aprobacion');
    const cEmail = _idx(enc, 'Email');
    const cHoras = _idx(enc, esComp ? 'Horas a compensar' : 'Horas');

    for (let i = 1; i < data.length; i++) {
      if (data[i][cId] !== id) continue;
      if (data[i][cEst] !== 'Pendiente') {
        throw new Error('Esta solicitud ya fue procesada (' + data[i][cEst] + ').');
      }

      const estado = (accion === 'aprobar') ? 'Aprobada' : 'Rechazada';
      let saldoNegativoConfirmado = false;

      if (esComp && estado === 'Aprobada') {
        const validacion = validarCompensacion(data[i][cEmail], parseFloat(data[i][cHoras]) || 0);
        if (!validacion.ok) {
          if (!confirmar) {
            // No es un error: es un estado intermedio que el cliente
            // muestra como "confirmar aprobacion en descubierto".
            return { ok: false, requiereConfirmacion: true, mensaje: validacion.mensaje };
          }
          saldoNegativoConfirmado = true;
        }
      }

      sh.getRange(i + 1, cEst + 1).setValue(estado);
      sh.getRange(i + 1, cApr + 1).setValue(yo.email);
      sh.getRange(i + 1, cFec + 1).setValue(new Date());

      _log(id, estado.toUpperCase(), yo.email, '');
      if (saldoNegativoConfirmado) {
        _log(id, 'APROBADA_SALDO_NEGATIVO', yo.email,
             'Aprobada con saldo insuficiente, confirmado explicitamente por el Jefe desde la WebApp.');
      }
      _notificarResultado(data[i], estado, esComp, enc);

      return { ok: true, id: id, estado: estado };
    }
    throw new Error('No se encontro la solicitud.');
  } finally {
    lock.releaseLock();
  }
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
