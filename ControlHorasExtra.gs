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
 *
 * ESTADOS de una solicitud o canje (columna Estado): Pendiente | Aprobada |
 * Rechazada | Anulada | Retirada. Solo Aprobada suma a saldos y liquidacion.
 *  - Anulada: la dejo sin efecto el Jefe despues de haberla resuelto (o antes).
 *    Es reversible: el Jefe puede volver a Aprobada/Rechazada/Pendiente.
 *  - Retirada: la saco su propio autor mientras estaba Pendiente. Es terminal.
 * Las columnas "Aprobado por" / "Fecha aprobacion" son la ULTIMA DECISION del
 * Jefe (se vacian si la solicitud vuelve a Pendiente). El historial completo
 * de cambios vive en la hoja Auditoria. Nunca se borran filas.
 */

// ============================ CONFIG ============================
const CONFIG = {
  WEBAPP_URL:    'https://script.google.com/macros/s/XXXX/exec', // <-- pegar tras implementar
  NOMBRE_PLANTA: 'Planta Graffigna - Fraccionamiento',
  HORAS_POR_DIA: 8,        // equivalencia para compensacion en dias
  TZ:            'America/Argentina/San_Juan',

  // Cargo (no nombre) con el que firma el mail de canje. El nombre sale de
  // la hoja Correos, del Jefe que arma el mail.
  FIRMA_CARGO:   'Jefe de Fraccionamiento · Planta Graffigna',

  // Politica FLC-DOC-RH-092: desde esta fecha (inclusive), las horas extra
  // de sabado, domingo o feriado se LIQUIDAN (se pagan) y dejan de sumar al
  // saldo de compensacion. Las de dia de semana, y CUALQUIER hora anterior
  // a esta fecha (aunque haya caido sabado/domingo/feriado), siguen sumando
  // al saldo como siempre. Ver clasificarDia()/circuitoHE(), fuente unica
  // de esta clasificacion.
  // Formato yyyy-MM-dd ESTRICTO (lo parsea _vigenciaNum() con una regex
  // fija). No usar Date aca: comparar fechas como Date arrastra la zona
  // horaria del servidor (ver nota de TZ en clasificarDia).
  VIGENCIA_LIQUIDACION: '2026-08-01',

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

const SH = { SOL: 'Solicitudes', COMP: 'Compensaciones', LOG: 'Auditoria', COR: 'Correos', FER: 'Feriados' };

const COL_SOL  = ['ID','Timestamp','Supervisor','Email','Fecha HE','Horas','Linea','Motivo',
                  'Estado','Aprobado por','Fecha aprobacion','Comentario','Token'];
const COL_COMP = ['ID','Timestamp','Supervisor','Email','Fecha solicitada','Horas a compensar',
                  'Tipo','Estado','Aprobado por','Fecha aprobacion','Comentario','Token'];
const COL_LOG  = ['Timestamp','ID','Accion','Usuario','Detalle'];
const COL_COR  = ['Email','Nombre','Rol','Activo'];
// Hoja "Feriados": un feriado por fila. Solo "Fecha" es obligatoria; "Nombre"
// es el que se muestra en mails/UI; "Fuente" es texto libre para auditar de
// donde sale (ej: "Decreto 106/2026"), no se valida ni se usa en logica.
const COL_FER  = ['Fecha', 'Nombre', 'Fuente'];

const ROLES_VALIDOS = ['Supervisor', 'Jefe', 'Personas'];

// Estados que el Jefe puede elegir al editar una solicitud o un canje. Retirada
// no esta: la pone solo el autor y es terminal (nadie la edita).
const ESTADOS_EDITABLES_JEFE = ['Pendiente', 'Aprobada', 'Rechazada', 'Anulada'];
// Lineas que acepta el alta y la edicion desde la app (una fila cargada por el
// Form puede traer otro texto, que se conserva mientras no se toque).
const LINEAS_VALIDAS = ['L1', 'L2', 'L3', 'Varias'];

// Acciones de Auditoria que se muestran en Administracion > Ultimos cambios.
const ACCIONES_ACTIVIDAD = ['ANULADA', 'DESANULADA', 'VUELTA_A_PENDIENTE', 'CAMBIO_DECISION', 'CORRECCION_DATOS',
  'EDITADA_SALDO_NEGATIVO', 'SUPERVISOR_EDICION', 'RETIRADA', 'PERSONA_ALTA', 'PERSONA_EDICION',
  'PERSONA_BAJA', 'PERSONA_REACTIVADA', 'ERROR_MAIL'];
const ACCION_TEXTO = {
  ANULADA: 'Anulada', DESANULADA: 'Deja de estar anulada', VUELTA_A_PENDIENTE: 'Volvió a pendiente',
  CAMBIO_DECISION: 'Cambio de decisión', CORRECCION_DATOS: 'Corrección de datos',
  EDITADA_SALDO_NEGATIVO: 'Saldo en descubierto', SUPERVISOR_EDICION: 'Corregida por el supervisor',
  RETIRADA: 'Retirada por el supervisor', PERSONA_ALTA: 'Alta de persona', PERSONA_EDICION: 'Persona modificada',
  PERSONA_BAJA: 'Persona desactivada', PERSONA_REACTIVADA: 'Persona reactivada', ERROR_MAIL: 'Mail no enviado'
};
// Solo para el historial de UNA solicitud (movimientos que no son "actividad").
const ACCION_TEXTO_HISTORIAL = {
  ALTA_HE: 'Alta', ALTA_COMP: 'Alta', APROBADA: 'Aprobada', RECHAZADA: 'Rechazada',
  APROBADA_SALDO_NEGATIVO: 'Aprobada en descubierto'
};

const CACHE_KEY_DIRECTORIO = 'directorio_correos';
const CACHE_TTL_DIRECTORIO = 300; // segundos

const CACHE_KEY_FERIADOS = 'feriados_v1';
const CACHE_TTL_FERIADOS = 300; // segundos

// ==================== NORMALIZACION ====================
/**
 * Normaliza un email para comparar y para usar como clave de mapa:
 * sin espacios y en minuscula. Usar SIEMPRE que se compare un email o
 * se use un email como clave (saldoSupervisor, tablaSaldos, _directorio,
 * validarCompensacion, rolDe, nombreDe). Sin esto, "Juan.Perez@ejemplo.invalid"
 * y "juan.perez@ejemplo.invalid" son dos personas distintas para el sistema.
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
  // _ensureSheet ya es idempotente (solo escribe encabezados si la hoja
  // esta vacia), asi que volver a correr setup() en un Sheet en produccion
  // no toca las hojas existentes: solo crea "Feriados" si todavia no existe.
  _ensureHojaFeriados(ss);

  const avisoTZ = _chequearTZ();
  SpreadsheetApp.getUi().alert(
    (avisoTZ ? avisoTZ + '\n\n' : '') +
    'Hojas creadas. Completar la hoja "Correos" con los correos reales ' +
    '(al menos un Jefe activo), cargar los feriados en la hoja "Feriados" ' +
    '(Fecha + Nombre; ver politica FLC-DOC-RH-092) y revisar ' +
    'CONFIG.WEBAPP_URL tras implementar la WebApp.'
  );
}

/**
 * Compara la zona horaria de la PLANILLA con la del script.
 *
 * Por que importa: una celda de fecha vuelve de getValues() como un Date
 * construido en la zona de la PLANILLA, y _partesFecha lo lee con
 * getFullYear/getMonth/getDate, que son hora local del SCRIPT. Si las dos
 * zonas no coinciden, el trio (anio,mes,dia) se corre un dia entero.
 *
 * Con la politica FLC-DOC-RH-092 eso ya no es un detalle cosmetico: un
 * sabado leido como viernes deja de liquidarse Y se muda al saldo de
 * compensacion. Dos errores a la vez, iguales en todas las vistas, asi que
 * nada se ve inconsistente y nadie lo nota.
 *
 * El calculo del dia de semana usa aritmetica UTC y es correcto; lo que esta
 * guarda cubre es el paso previo, de donde sale el trio.
 *
 * @returns {string} mensaje de alerta, o '' si las zonas coinciden.
 */
function _chequearTZ() {
  try {
    const tzHoja = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    if (tzHoja === CONFIG.TZ) return '';
    return 'ATENCION - ZONA HORARIA DISTINTA\n' +
      'La planilla esta en "' + tzHoja + '" y el script en "' + CONFIG.TZ + '".\n' +
      'Con zonas distintas, una fecha puede leerse corrida un dia, y un sabado ' +
      'leido como viernes deja de liquidarse. Corregir en Archivo > ' +
      'Configuracion de la hoja de calculo > Zona horaria antes de usar el sistema.';
  } catch (err) {
    return '';   // sin acceso a la planilla no bloqueamos setup()
  }
}

/**
 * Diagnostico para correr a mano desde el editor cuando algo de fechas no
 * cierra. Deja el resultado en el log de ejecuciones.
 */
function verificarZonaHoraria() {
  const aviso = _chequearTZ();
  const msg = aviso || ('Zona horaria correcta: planilla y script en "' + CONFIG.TZ + '".');
  console.log(msg);
  return msg;
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

/**
 * Crea (si no existe) la hoja "Feriados" usada por _feriadosMap()/
 * clasificarDia() para saber que "Fecha HE" es feriado. Mismo patron que
 * _ensureHojaCorreos: _ensureSheet ya es idempotente, esta funcion solo
 * agrega validacion de datos sobre la columna Fecha.
 *
 * A PROPOSITO no precarga ningun feriado (ni siquiera de ejemplo con fecha
 * real): la lista de feriados es un dato operativo que cambia todos los
 * anios y que Gerencia de Personas tiene que cargar y mantener a mano; un
 * feriado hardcodeado en el codigo se desactualiza en silencio.
 */
function _ensureHojaFeriados(ss) {
  const sh = _ensureSheet(ss, SH.FER, COL_FER);
  const filas = Math.max(sh.getMaxRows() - 1, 1);

  const colFecha = _idx(COL_FER, 'Fecha') + 1;
  const reglaFecha = SpreadsheetApp.newDataValidation()
    .requireDate()
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, colFecha, filas, 1).setDataValidation(reglaFecha);
  sh.getRange(2, colFecha, filas, 1).setNumberFormat('dd/MM/yyyy');
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

// ==================== FERIADOS (hoja Feriados) ====================
// Memo por ejecucion: una sola lectura de la hoja/cache basta para
// clasificar todas las filas que haga falta clasificar dentro de la misma
// llamada a apiEstado/apiCalendario/apiConsulta/etc. Se reinicia solo (cada
// invocacion del script corre en un contexto nuevo); invalidarCacheFeriados()
// lo limpia ademas por si alguna ejecucion larga reutiliza contexto.
let _feriadosMemo = null;

/**
 * Mapa 'yyyy-MM-dd' -> nombre del feriado ('' si la fila no tiene Nombre).
 * Espejo exacto del patron de _directorio(): cache de scriptCache (300s),
 * si falla o no hay cache lee la hoja "Feriados" directo.
 *
 * Degrada a {} (nunca lanza) si la hoja no existe, si esta vacia, o si sus
 * encabezados estan rotos: un feriado mal cargado no puede tumbar apiEstado
 * entero para todo el mundo. Un feriado que "no se ve" por un encabezado
 * roto es un problema visible y corregible (basta arreglar el encabezado);
 * apiEstado caido para todos es mucho peor.
 *
 * No cachea un mapa vacio, por la misma razon que _directorio(): si alguien
 * carga la hoja recien despues de que quedo cacheada vacia, no queremos
 * que el sistema seguera "sin feriados" hasta 5 minutos despues.
 *
 * @returns {Object<string,string>}
 */
function _feriadosMap() {
  if (_feriadosMemo) return _feriadosMemo;

  const cache = _cacheSeguro();
  if (cache) {
    try {
      const cacheado = cache.get(CACHE_KEY_FERIADOS);
      if (cacheado) {
        _feriadosMemo = JSON.parse(cacheado);
        return _feriadosMemo;
      }
    } catch (err) {
      // si falla la lectura del cache, seguimos y leemos la hoja
    }
  }

  // Los mapas vacios no se cachean a proposito (ver abajo), asi que el memo
  // por ejecucion es lo UNICO que corta el ciclo en estos dos caminos. Sin
  // el, circuitoHE() vuelve a leer la hoja una vez POR FILA: justo el dia
  // del despliegue, con "Feriados" recien creada y todavia vacia, un
  // apiEstado del Jefe se convierte en cientos de lecturas al Spreadsheet.
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH.FER);
  if (!sh) { _feriadosMemo = {}; return _feriadosMemo; }
  const data = sh.getDataRange().getValues();
  if (data.length < 2) { _feriadosMemo = {}; return _feriadosMemo; }

  const mapa = {};
  try {
    const enc = data[0];
    const cFecha  = _idx(enc, 'Fecha');
    const cNombre = _idx(enc, 'Nombre');

    for (let i = 1; i < data.length; i++) {
      const partes = _partesFecha(data[i][cFecha]);
      if (!partes) continue; // fila sin fecha legible: se ignora, no rompe nada
      const clave = partes.anio + '-' + _pad2(partes.mes) + '-' + _pad2(partes.dia);
      mapa[clave] = String(data[i][cNombre] || '').trim();
    }
  } catch (err) {
    // Encabezado de "Feriados" roto (columna renombrada/borrada): degrada a
    // {} y deja traza, en vez de tumbar apiEstado para todo el mundo.
    console.error('_feriadosMap: encabezados de "Feriados" invalidos: ' + err.message);
    _feriadosMemo = {};
    return _feriadosMemo;
  }

  if (cache && Object.keys(mapa).length > 0) {
    try {
      cache.put(CACHE_KEY_FERIADOS, JSON.stringify(mapa), CACHE_TTL_FERIADOS);
    } catch (err) {
      // sin cache disponible no es critico
    }
  }

  _feriadosMemo = mapa;
  return mapa;
}

function _pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * Escapa texto para meterlo en el HTML de un mail. Los mails se arman
 * concatenando strings, y varios de los valores que entran los tipea una
 * persona (motivo, linea, nombre del feriado).
 */
function _escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Correr manualmente despues de editar la hoja "Feriados" (alta, baja o
 * correccion de una fecha) para que el cambio se refleje de inmediato en
 * clasificarDia()/circuitoHE() y en todo lo que dependa de ellos (saldos,
 * resumenMensual, calendario, panel de consulta). Sin esto, el cache vence
 * solo a los 5 minutos. Ver caso de prueba 6 del plan: cargar un feriado
 * nuevo + invalidarCacheFeriados() reclasifica al toque una solicitud ya
 * cargada, sin tocarla.
 */
function invalidarCacheFeriados() {
  // Foto de los feriados ANTES de recargar, para poder decir que cambio.
  let antes = {};
  try { antes = _feriadosMap(); } catch (err) { antes = {}; }

  _feriadosMemo = null;
  const cache = _cacheSeguro();
  if (cache) {
    try {
      cache.remove(CACHE_KEY_FERIADOS);
    } catch (err) {
      // sin cache no hay nada que borrar
    }
  }

  let despues = {};
  try { despues = _feriadosMap(); } catch (err) { despues = {}; }
  _auditarCambioFeriados(antes, despues);
}

/**
 * Deja en "Auditoria" que feriados se agregaron o se sacaron.
 *
 * Por que hace falta: el tipo de dia se calcula al vuelo y no se guarda en
 * "Solicitudes". Eso hace que corregir un feriado olvidado reclasifique solo
 * las horas de ese dia, que es lo que se busca. Pero funciona igual en la
 * direccion incomoda: agregar un feriado mueve horas ya aprobadas del saldo
 * de compensacion a liquidacion, y el saldo de alguien baja sin que haya
 * ocurrido ningun evento. Sin esta traza no habria forma de reconstruir
 * despues por que cambio.
 */
function _auditarCambioFeriados(antes, despues) {
  try {
    const agregados = Object.keys(despues).filter(k => !(k in antes)).sort();
    const quitados  = Object.keys(antes).filter(k => !(k in despues)).sort();
    if (!agregados.length && !quitados.length) return;

    let quien = '';
    try { quien = Session.getActiveUser().getEmail() || ''; } catch (err) { quien = ''; }

    const partes = [];
    if (agregados.length) partes.push('agregados: ' + agregados.join(', '));
    if (quitados.length)  partes.push('quitados: ' + quitados.join(', '));
    _log('-', 'FERIADOS_CAMBIO', quien, partes.join(' | ') +
         ' (reclasifica horas ya aprobadas de esos dias)');
  } catch (err) {
    // la auditoria nunca debe impedir que se refresquen los feriados
    console.error('_auditarCambioFeriados: ' + err.message);
  }
}

// ==================== CLASIFICACION DE DIA / CIRCUITO (FLC-DOC-RH-092) ====================
/**
 * CONFIG.VIGENCIA_LIQUIDACION como entero comparable (anio*10000+mes*100+dia).
 * Comparar la vigencia como ENTEROS, nunca como Date: un Date arrastra la
 * zona horaria del servidor y puede correr la fecha un dia. Lanza un error
 * visible si CONFIG.VIGENCIA_LIQUIDACION no tiene el formato yyyy-MM-dd
 * exacto, en vez de fallar en silencio con NaN.
 * @returns {number}
 */
function _vigenciaNum() {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(CONFIG.VIGENCIA_LIQUIDACION || ''));
  if (!m) throw new Error('CONFIG.VIGENCIA_LIQUIDACION invalida: tiene que tener formato yyyy-MM-dd. Valor actual: "' + CONFIG.VIGENCIA_LIQUIDACION + '"');
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/**
 * Clasifica un valor de "Fecha HE" por tipo de dia.
 * FUENTE DE VERDAD UNICA: todo lo que necesite saber si un dia es sabado,
 * domingo, feriado o dia de semana pasa por aca. No reimplementar en el
 * cliente ni en otra funcion.
 *
 * TZ: NO usa Date.getDay() sobre el valor crudo. Extrae {anio,mes,dia} con
 * _partesFecha() y calcula el dia de semana con aritmetica UTC pura:
 *   new Date(Date.UTC(anio, mes-1, dia)).getUTCDay()
 * Asi el resultado depende SOLO del triple (anio,mes,dia), nunca de la zona
 * horaria del servidor ni de la hora del dia.
 *
 * Precedencia: Feriado > Sabado > Domingo > Semana (un feriado que cae
 * sabado se reporta Feriado, no Sabado).
 *
 * @param {*} v valor crudo de "Fecha HE" (Date de celda o texto)
 * @returns {{tipo:'Feriado'|'Sabado'|'Domingo'|'Semana'|'Desconocido',
 *            feriadoNombre:string|null, clave:string|null,
 *            partes:{anio:number,mes:number,dia:number}|null}}
 */
function clasificarDia(v) {
  const partes = _partesFecha(v);
  if (!partes) {
    return { tipo: 'Desconocido', feriadoNombre: null, clave: null, partes: null };
  }

  const clave = partes.anio + '-' + _pad2(partes.mes) + '-' + _pad2(partes.dia);
  const feriados = _feriadosMap();
  if (Object.prototype.hasOwnProperty.call(feriados, clave)) {
    return { tipo: 'Feriado', feriadoNombre: feriados[clave] || '', clave: clave, partes: partes };
  }

  const dow = new Date(Date.UTC(partes.anio, partes.mes - 1, partes.dia)).getUTCDay();
  let tipo;
  if (dow === 6) tipo = 'Sabado';
  else if (dow === 0) tipo = 'Domingo';
  else tipo = 'Semana';

  return { tipo: tipo, feriadoNombre: null, clave: clave, partes: partes };
}

/**
 * A que bolsa va una hora extra segun su Fecha HE (FLC-DOC-RH-092).
 *  - fecha < CONFIG.VIGENCIA_LIQUIDACION -> 'COMP' siempre (no retroactiva)
 *  - fecha >= vigencia y Sabado/Domingo/Feriado -> 'LIQ'
 *  - fecha >= vigencia y Semana -> 'COMP'
 *  - Desconocido (fecha ilegible) -> 'COMP' (no se paga lo inverificable)
 *
 * @param {*} v valor crudo de "Fecha HE"
 * @returns {{circuito:'LIQ'|'COMP', tipo:string, feriadoNombre:string|null,
 *            preVigencia:boolean, clave:string|null}}
 */
function circuitoHE(v) {
  const c = clasificarDia(v);

  if (c.tipo === 'Desconocido') {
    return { circuito: 'COMP', tipo: c.tipo, feriadoNombre: null, preVigencia: false, clave: null };
  }

  const fechaNum = c.partes.anio * 10000 + c.partes.mes * 100 + c.partes.dia;
  const preVigencia = fechaNum < _vigenciaNum();

  const esFindeOFeriado = (c.tipo === 'Sabado' || c.tipo === 'Domingo' || c.tipo === 'Feriado');
  const circuito = (!preVigencia && esFindeOFeriado) ? 'LIQ' : 'COMP';

  return { circuito: circuito, tipo: c.tipo, feriadoNombre: c.feriadoNombre, preVigencia: preVigencia, clave: c.clave };
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

  // Clasificar el valor ORIGINAL que ya tenemos en memoria (fecha), NUNCA
  // releer la fila recien escrita: son el mismo dato, releer solo agrega
  // una vuelta a la hoja para nada y arriesga una inconsistencia si algo
  // cambia entre el appendRow y la lectura.
  const c = circuitoHE(fecha);

  // Resolver el destinatario ANTES de escribir la fila: si no hay Jefe
  // configurado en la hoja "Correos", mejor que falle aca (nada se guarda)
  // a que quede una solicitud huerfana: escrita pero sin nadie que la
  // pueda ver ni aprobar.
  const destinatarioJefe = jefeEmail();

  sh.appendRow([id, new Date(), _celdaSegura(supervisor), email, fecha, horas, _celdaSegura(linea), _celdaSegura(motivo),
                'Pendiente', '', '', '', token]);

  _log(id, 'ALTA_HE', email, horasTexto + ' hs - ' + fechaTexto + ' [' + c.circuito + '/' + c.tipo + ']');

  // El mail SI dice el circuito (ver _enviarMailPendienteHE).
  _enviarMailPendienteHE({
    to: destinatarioJefe, id: id, token: token, supervisor: supervisor, email: email,
    fecha: fecha, horas: horas, linea: linea, motivo: motivo
  });

  return { id: id };
}

/**
 * Arma y manda al Jefe el mail de aprobacion de una HE Pendiente. Lo usan el
 * alta (_crearHoraExtra) y el reenvio cuando el Jefe edita una solicitud y
 * queda Pendiente. NO lanza nunca: si MailApp falla (cuota, etc.) deja traza
 * ERROR_MAIL en Auditoria y devuelve false; la fila ya esta guardada.
 *
 * El mail SI dice el circuito: el Jefe esta autorizando dos cosas distintas
 * (un pago o un descanso a cuenta de saldo), y tiene que poder distinguirlas
 * de un vistazo antes de aprobar.
 *
 * @param {{to:string, id:string, token:string, supervisor:string, email:string,
 *          fecha:(string|Date), horas:number, linea:string, motivo:string,
 *          prefijoAsunto:(string|undefined), notaHtml:(string|undefined)}} o
 *   prefijoAsunto y notaHtml son '' en el alta; en el reenvio marcan el
 *   asunto y van ANTES del cuerpo.
 * @returns {boolean} true si el mail salio
 */
function _enviarMailPendienteHE(o) {
  const fechaTexto = _fmtFecha(o.fecha);
  const horasTexto = _fmtHoras(o.horas);
  const c = circuitoHE(o.fecha);

  let lineaTipoDia;
  if (c.circuito === 'LIQ') {
    lineaTipoDia = c.tipo + (c.feriadoNombre ? ' (' + c.feriadoNombre + ')' : '') + ' — LIQUIDABLE (se paga)';
  } else if (c.tipo === 'Semana') {
    lineaTipoDia = 'Dia de semana — compensable (suma al saldo)';
  } else {
    lineaTipoDia = c.tipo + ' — compensable (anterior a la vigencia ' +
      CONFIG.VIGENCIA_LIQUIDACION.split('-').reverse().join('/') + ')';
  }

  try {
    MailApp.sendEmail({
      to: o.to,
      subject: (o.prefijoAsunto || '') + (c.circuito === 'LIQ' ? '[HE Pendiente · LIQUIDABLE] ' : '[HE Pendiente] ') +
        o.supervisor + ' - ' + horasTexto + ' hs - ' + fechaTexto,
      htmlBody: (o.notaHtml || '') + _mailAprobacion({
        titulo: 'Solicitud de Horas Extra',
        id: o.id, token: o.token, tipo: 'HE',
        filas: [
          ['Supervisor', o.supervisor],
          ['Fecha HE', fechaTexto],
          ['Horas', horasTexto],
          ['Linea / Sector', o.linea],
          ['Motivo', o.motivo],
          ['Tipo de dia', lineaTipoDia]
        ]
      })
    });
    return true;
  } catch (err) {
    // La fila ya quedo guardada. Si el mail falla dejamos traza en Auditoria
    // en vez de perder la solicitud en silencio.
    // usuarioLog: quien disparo el envio (el Jefe cuando es un reenvio por
    // edicion). Sin esto, Auditoria le atribuia la falla al supervisor.
    _log(o.id, 'ERROR_MAIL', o.usuarioLog || o.email, 'No se pudo notificar al Jefe: ' + err.message);
    return false;
  }
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

  sh.appendRow([id, new Date(), _celdaSegura(supervisor), email, fecha, horas, _celdaSegura(tipo),
                'Pendiente', '', '', '', token]);

  _log(id, 'ALTA_COMP', email, _fmtHoras(horas) + ' hs - ' + fechaTexto + (validacion.ok ? '' : ' [SALDO INSUFICIENTE]'));

  _enviarMailPendienteCP({
    to: destinatarioJefe, id: id, token: token, supervisor: supervisor, email: email,
    fecha: fecha, tipo: tipo, horas: horas
  });

  return { id: id, saldoOk: validacion.ok };
}

/**
 * Arma y manda al Jefe el mail de aprobacion de un canje Pendiente. Lo usan
 * el alta (_crearCompensacion) y el reenvio cuando el Jefe edita un canje y
 * queda Pendiente. Calcula validarCompensacion(email, horas) adentro (alerta
 * de saldo insuficiente + asunto [SALDO INSUFICIENTE]). NO lanza nunca: si
 * MailApp falla deja ERROR_MAIL en Auditoria y devuelve false.
 *
 * @param {{to:string, id:string, token:string, supervisor:string, email:string,
 *          fecha:(string|Date), tipo:string, horas:number,
 *          prefijoAsunto:(string|undefined), notaHtml:(string|undefined)}} o
 * @returns {boolean} true si el mail salio
 */
function _enviarMailPendienteCP(o) {
  const fechaTexto = _fmtFecha(o.fecha);
  const validacion = validarCompensacion(o.email, o.horas);

  const alerta = !validacion.ok
    ? '<p style="background:#B00020;color:#fff;font-weight:bold;padding:10px 14px;' +
      'border-radius:4px;margin-bottom:16px">ATENCION: saldo insuficiente ' +
      '(saldo actual: ' + _fmtHoras(validacion.saldo) + ' hs, solicitado ' +
      _fmtHoras(o.horas) + ' hs). La solicitud quedo guardada igual como ' +
      'Pendiente: vos decidis si se aprueba.</p>'
    : '';

  try {
    MailApp.sendEmail({
      to: o.to,
      subject: (o.prefijoAsunto || '') + (validacion.ok ? '' : '[SALDO INSUFICIENTE] ') +
        '[Compensacion Pendiente] ' + o.supervisor + ' - ' + fechaTexto,
      htmlBody: (o.notaHtml || '') + alerta + _mailAprobacion({
        titulo: 'Solicitud de Compensacion',
        id: o.id, token: o.token, tipo: 'CP',
        filas: [
          ['Supervisor', o.supervisor],
          ['Fecha solicitada', fechaTexto],
          ['Tipo', o.tipo],
          ['Horas a descontar', _fmtHoras(o.horas)],
          ['Saldo disponible', _fmtHoras(validacion.saldo) + ' hs']
        ]
      })
    });
    return true;
  } catch (err) {
    // usuarioLog: quien disparo el envio (el Jefe cuando es un reenvio por
    // edicion). Sin esto, Auditoria le atribuia la falla al supervisor.
    _log(o.id, 'ERROR_MAIL', o.usuarioLog || o.email, 'No se pudo notificar al Jefe: ' + err.message);
    return false;
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
      mensaje: 'Saldo compensable insuficiente: disponible ' + _fmtHoras(saldo) +
               ' hs, solicitado ' + _fmtHoras(horasNum) + ' hs. (Las horas de ' +
               'sab/dom/feriado desde el ' + CONFIG.VIGENCIA_LIQUIDACION.split('-').reverse().join('/') +
               ' se liquidan y no se pueden compensar.)'
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
      // Desde que el Jefe puede modificar solicitudes, el token se regenera en cada
      // cambio: un link de un mail viejo cae aca y es el caso normal, no un error.
      if (String(data[i][cTok]) !== p.token) {
        return _html('Este link ya no es valido: la solicitud se modifico despues de que se envio este mail. ' +
                     'Abri el mail mas reciente o entra a la app.', '#8A6D00');
      }
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

/** Nombre de un tipo de dia en minuscula, para meterlo en una oracion (mail). */
function _tipoDiaTextoLower(tipo) {
  if (tipo === 'Sabado') return 'sabado';
  if (tipo === 'Domingo') return 'domingo';
  if (tipo === 'Feriado') return 'feriado';
  if (tipo === 'Semana') return 'dia de semana';
  return 'fecha no interpretable';
}

/**
 * Linea de saldo de los mails al supervisor (resultado de una aprobacion o
 * modificacion del Jefe). HTML sin envolver en <p>. Una sola pasada por
 * Solicitudes: saldoSupervisor() volveria a llamar a _desgloseHE por dentro, y
 * esto corre dentro del lock.
 */
function _lineaSaldoMail(email, esComp) {
  if (esComp) {
    return 'Saldo compensable: <b>' + _fmtHoras(saldoSupervisor(email)) + ' hs</b>.';
  }
  const d = _desgloseHE(email);
  const saldoComp = d.compensables - _sumaAprobadas(SH.COMP, email);
  return 'Saldo compensable: <b>' + _fmtHoras(saldoComp) + ' hs</b> &middot; ' +
    'En liquidacion desde el ' + CONFIG.VIGENCIA_LIQUIDACION.split('-').reverse().join('/') +
    ': <b>' + _fmtHoras(d.liqTotal) + ' hs</b>.';
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

  let cuerpoExtra = '';
  if (!esComp) {
    // Rama HE: el mail SI dice el circuito (el Jefe autorizo un pago o un
    // descanso a cuenta de saldo: son cosas distintas y el supervisor
    // tiene que poder distinguirlas).
    const c = circuitoHE(fila[cFecha]);
    // El nombre del feriado lo tipea una persona en la hoja: escapar antes
    // de concatenarlo al HTML del mail.
    const tipoTexto = _escHtml(_tipoDiaTextoLower(c.tipo) + (c.tipo === 'Feriado' && c.feriadoNombre ? ' (' + c.feriadoNombre + ')' : ''));
    if (c.circuito === 'LIQ') {
      cuerpoExtra = '<p>Esta solicitud corresponde a <b>' + tipoTexto + '</b>: entra en ' +
        '<b>liquidacion</b> (se paga). No suma al saldo de compensacion.</p>';
    } else if (c.tipo === 'Semana') {
      cuerpoExtra = '<p>Esta solicitud corresponde a <b>' + tipoTexto + '</b>: suma al saldo de compensacion.</p>';
    } else if (c.tipo === 'Desconocido') {
      cuerpoExtra = '<p>No pudimos interpretar la fecha de esta solicitud: se trata como compensable.</p>';
    } else {
      cuerpoExtra = '<p>Esta solicitud corresponde a <b>' + tipoTexto + '</b>, pero es anterior a la ' +
        'vigencia del ' + CONFIG.VIGENCIA_LIQUIDACION.split('-').reverse().join('/') +
        ': suma al saldo de compensacion (no es retroactiva).</p>';
    }
  }
  const lineaSaldo = _lineaSaldoMail(email, esComp);

  const cuerpo =
    '<p>Hola ' + _escHtml(supervisor) + ',</p>' +
    '<p>Tu solicitud del <b>' + fecha + '</b> (' + horas + ' hs) fue <b>' +
    estado.toLowerCase() + '</b>.</p>' +
    cuerpoExtra +
    '<p>' + lineaSaldo + '</p>' +
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
 *
 * @param {string} hoja
 * @param {string} email
 * @param {{id:string, estado:string, horas:number}} [simular] Opcional. Reemplaza
 *   el estado y las horas de UNA fila (la de ese ID) solo durante esta pasada,
 *   SIN tocar la hoja: sirve para calcular el "despues" de una edicion con la
 *   misma regla que el saldo real. Se sustituye primero y recien despues se
 *   filtra por Aprobada. Sin este parametro el comportamiento es el de siempre.
 */
function _sumaAprobadas(hoja, email, simular) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const buscado = _normEmail(email);
  const d = ss.getSheetByName(hoja).getDataRange().getValues();
  if (d.length < 2) return 0;
  const enc = d[0];
  const cEmail  = _idx(enc, 'Email');
  const cEstado = _idx(enc, 'Estado');
  const cHoras  = _idx(enc, hoja === SH.SOL ? 'Horas' : 'Horas a compensar');
  const cId     = simular ? _idx(enc, 'ID') : -1;
  let total = 0;
  for (let i = 1; i < d.length; i++) {
    if (_normEmail(d[i][cEmail]) !== buscado) continue;
    let estado = d[i][cEstado];
    let horas = d[i][cHoras];
    if (simular && String(d[i][cId]) === simular.id) {
      estado = simular.estado;
      horas = simular.horas;
    }
    if (estado === 'Aprobada') {
      total += parseFloat(horas) || 0;
    }
  }
  return total;
}

/**
 * Suma de horas APROBADAS de Solicitudes de un email, desglosada por
 * circuito (FLC-DOC-RH-092), en UNA sola pasada por la hoja. Reemplaza a
 * _sumaAprobadas(SH.SOL, email) en todo calculo de saldo/generadas — esa
 * funcion queda vigente SOLO para Compensaciones (_sumaAprobadas(SH.COMP,...)).
 *
 * @param {string} email
 * @param {{id:string, estado:string, horas:number, fecha:*}} [simular] Opcional.
 *   Reemplaza estado, horas y fecha de UNA fila (la de ese ID) solo durante la
 *   pasada, sin tocar la hoja (ver _sumaAprobadas). Primero se sustituye y
 *   despues se filtra: si no, "Pendiente -> Aprobada" nunca sumaria.
 * @returns {{compensables:number, liqSabDom:number, liqFeriado:number,
 *            liqTotal:number, sinFecha:number}}
 */
function _desgloseHE(email, simular) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const buscado = _normEmail(email);
  const d = ss.getSheetByName(SH.SOL).getDataRange().getValues();
  const out = { compensables: 0, liqSabDom: 0, liqFeriado: 0, liqTotal: 0, sinFecha: 0 };
  if (d.length < 2) return out;

  const enc = d[0];
  const cEmail  = _idx(enc, 'Email');
  const cEstado = _idx(enc, 'Estado');
  const cHoras  = _idx(enc, 'Horas');
  const cFecha  = _idx(enc, 'Fecha HE');
  const cId     = simular ? _idx(enc, 'ID') : -1;

  for (let i = 1; i < d.length; i++) {
    if (_normEmail(d[i][cEmail]) !== buscado) continue;
    let estado = d[i][cEstado];
    let horasCrudas = d[i][cHoras];
    let fecha = d[i][cFecha];
    if (simular && String(d[i][cId]) === simular.id) {
      estado = simular.estado;
      horasCrudas = simular.horas;
      fecha = simular.fecha;
    }
    if (estado !== 'Aprobada') continue;
    const horas = parseFloat(horasCrudas) || 0;
    const c = circuitoHE(fecha);

    if (c.tipo === 'Desconocido') out.sinFecha++;

    if (c.circuito === 'LIQ') {
      if (c.tipo === 'Feriado') out.liqFeriado += horas;
      else out.liqSabDom += horas;
    } else {
      out.compensables += horas;
    }
  }
  out.liqTotal = out.liqSabDom + out.liqFeriado;
  return out;
}

/**
 * Desde FLC-DOC-RH-092 este saldo es SOLO compensable: las horas
 * liquidables (sabado/domingo/feriado con Fecha HE >= vigencia) NO entran
 * aca, se pagan por otro circuito. Ver _desgloseHE()/circuitoHE().
 * `simular` (opcional) se pasa tal cual a las dos sumas: ver _desgloseHE().
 */
function saldoSupervisor(email, simular) {
  return _desgloseHE(email, simular).compensables - _sumaAprobadas(SH.COMP, email, simular);
}

/**
 * Mapa email -> {nombre, generadas, compensadas, liqSabDom, liqFeriado} de
 * horas Aprobadas. IMPORTANTE (FLC-DOC-RH-092): "generadas" pasa a contar
 * SOLO horas compensables (se mantiene el nombre de la clave para no romper
 * resumenMensual, que la lee por ese nombre). Las horas liquidables quedan
 * aparte en liqSabDom/liqFeriado.
 */
function tablaSaldos() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const map = {};

  const dSol = ss.getSheetByName(SH.SOL).getDataRange().getValues();
  if (dSol.length >= 2) {
    const enc = dSol[0];
    const cEmail  = _idx(enc, 'Email');
    const cNombre = _idx(enc, 'Supervisor');
    const cEstado = _idx(enc, 'Estado');
    const cHoras  = _idx(enc, 'Horas');
    const cFecha  = _idx(enc, 'Fecha HE');
    for (let i = 1; i < dSol.length; i++) {
      if (dSol[i][cEstado] !== 'Aprobada') continue;
      const k = _normEmail(dSol[i][cEmail]);
      if (!k) continue;
      if (!map[k]) map[k] = { nombre: dSol[i][cNombre], generadas: 0, compensadas: 0, liqSabDom: 0, liqFeriado: 0 };
      const horas = parseFloat(dSol[i][cHoras]) || 0;
      const c = circuitoHE(dSol[i][cFecha]);
      if (c.circuito === 'LIQ') {
        if (c.tipo === 'Feriado') map[k].liqFeriado += horas;
        else map[k].liqSabDom += horas;
      } else {
        map[k].generadas += horas;
      }
    }
  }

  const dComp = ss.getSheetByName(SH.COMP).getDataRange().getValues();
  if (dComp.length >= 2) {
    const enc = dComp[0];
    const cEmail  = _idx(enc, 'Email');
    const cNombre = _idx(enc, 'Supervisor');
    const cEstado = _idx(enc, 'Estado');
    const cHoras  = _idx(enc, 'Horas a compensar');
    for (let i = 1; i < dComp.length; i++) {
      if (dComp[i][cEstado] !== 'Aprobada') continue;
      const k = _normEmail(dComp[i][cEmail]);
      if (!k) continue;
      if (!map[k]) map[k] = { nombre: dComp[i][cNombre], generadas: 0, compensadas: 0, liqSabDom: 0, liqFeriado: 0 };
      map[k].compensadas += parseFloat(dComp[i][cHoras]) || 0;
    }
  }

  return map;
}

// ==================== RESUMEN MENSUAL ====================
/**
 * Manda DOS tablas, con dos criterios de fecha distintos a proposito:
 *  - "Resumen de Horas Extra" (la de siempre): por Timestamp (cuando se
 *    CARGO la solicitud), agrupa TODA hora Aprobada sin distinguir
 *    circuito. La columna "Saldo compensable" es el saldo compensable
 *    ACTUAL de cada supervisor (no del mes: es un acumulado a la fecha).
 *  - "Liquidacion del mes (por Fecha HE)" (nueva, FLC-DOC-RH-092): por
 *    Fecha HE (cuando se TRABAJO la hora extra), solo horas LIQ
 *    (sabado/domingo/feriado con vigencia aplicada) del mes anterior. Se
 *    paga por cuando se trabajo, no por cuando se tipeo la solicitud.
 * Ademas lleva la tabla "Canjes del mes (por Fecha solicitada)": los canjes
 * (compensaciones aprobadas) se informan APARTE, no se suman ni se restan a
 * las horas extra de las tablas de arriba.
 */
function resumenMensual() {
  // OJO: el activador por tiempo llama resumenMensual(e) con un objeto
  // evento. No agregarle parametros: esta funcion los ignora a proposito.
  _enviarResumenMensual({ soloJefe: false });
}

/**
 * Prueba manual desde el editor: manda el resumen del MES EN CURSO solo al
 * Jefe, sin copia a Personas. Sirve para ver el mail antes del dia 1.
 */
function probarResumenMensual() {
  // Es global y la WebApp corre como quien la implementa: sin esta guarda,
  // cualquier cuenta del dominio podria dispararla desde la consola del
  // navegador. No se pone en resumenMensual() porque el activador por tiempo
  // puede correr sin usuario activo.
  const quien = _normEmail(Session.getActiveUser().getEmail() || '');
  if (!quien || quien !== _normEmail(jefeEmail())) {
    throw new Error('Solo el Jefe puede correr probarResumenMensual().');
  }
  _enviarResumenMensual({ soloJefe: true, mesEnCurso: true });
}

/**
 * Cuerpo de resumenMensual()/probarResumenMensual().
 * @param {{soloJefe:boolean, mesEnCurso:boolean}} op
 */
function _enviarResumenMensual(op) {
  op = op || {};
  const hoy = new Date();
  const desfase = op.mesEnCurso ? 0 : -1;
  const ini = new Date(hoy.getFullYear(), hoy.getMonth() + desfase, 1);
  const fin = new Date(hoy.getFullYear(), hoy.getMonth() + desfase + 1, 0, 23, 59, 59);
  const per = Utilities.formatDate(ini, CONFIG.TZ, 'MM/yyyy');
  const anioIni = ini.getFullYear(), mesIni = ini.getMonth() + 1; // mes del resumen (anterior, o el en curso si op.mesEnCurso), 1-12

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const d  = ss.getSheetByName(SH.SOL).getDataRange().getValues();
  const enc = d[0];
  const cTimestamp  = _idx(enc, 'Timestamp');
  const cSupervisor = _idx(enc, 'Supervisor');
  const cHoras      = _idx(enc, 'Horas');
  const cEstado     = _idx(enc, 'Estado');
  const cFecha      = _idx(enc, 'Fecha HE');

  const det = {};
  let total = 0, pend = 0;

  // Tabla nueva: acumula por supervisor segun "Fecha HE" (no Timestamp).
  const liq = {};
  let liqTotalSabDom = 0, liqTotalFeriado = 0;

  for (let i = 1; i < d.length; i++) {
    const ts = new Date(d[i][cTimestamp]);
    const estado = d[i][cEstado];
    const nombre = d[i][cSupervisor];
    const horas = parseFloat(d[i][cHoras]) || 0;

    if (estado === 'Aprobada') {
      // Tabla nueva: filtra por Fecha HE en el mes anterior, sin importar
      // cuando se cargo la solicitud.
      const partesHE = _partesFecha(d[i][cFecha]);
      if (partesHE && partesHE.anio === anioIni && partesHE.mes === mesIni) {
        const c = circuitoHE(d[i][cFecha]);
        if (c.circuito === 'LIQ') {
          if (!liq[nombre]) liq[nombre] = { sabDom: 0, feriado: 0 };
          if (c.tipo === 'Feriado') { liq[nombre].feriado += horas; liqTotalFeriado += horas; }
          else { liq[nombre].sabDom += horas; liqTotalSabDom += horas; }
        }
      }
    }

    // Tabla vieja: sigue filtrando por Timestamp, sin cambios de criterio.
    if (ts < ini || ts > fin) continue;
    if (estado === 'Pendiente') { pend++; continue; }
    if (estado !== 'Aprobada') continue;
    det[nombre] = (det[nombre] || 0) + horas;
    total += horas;
  }

  // Un solo lookup: mapa nombre -> saldo compensable, armado una vez.
  const saldos = tablaSaldos();
  const saldoPorNombre = {};
  Object.keys(saldos).forEach(email => {
    const info = saldos[email];
    saldoPorNombre[info.nombre] = info.generadas - info.compensadas;
  });

  let filas = '';
  Object.keys(det).sort().forEach(n => {
    const saldoCompensable = saldoPorNombre.hasOwnProperty(n) ? _fmtHoras(saldoPorNombre[n]) : '-';
    filas += '<tr><td>' + _escHtml(n) + '</td><td style="text-align:right">' + _fmtHoras(det[n]) +
             '</td><td style="text-align:right">' + saldoCompensable + '</td></tr>';
  });

  let filasLiq = '';
  Object.keys(liq).sort().forEach(n => {
    const t = liq[n].sabDom + liq[n].feriado;
    filasLiq += '<tr><td>' + _escHtml(n) + '</td><td style="text-align:right">' + _fmtHoras(liq[n].sabDom) +
                '</td><td style="text-align:right">' + _fmtHoras(liq[n].feriado) +
                '</td><td style="text-align:right"><b>' + _fmtHoras(t) + '</b></td></tr>';
  });
  const liqTotalGeneral = liqTotalSabDom + liqTotalFeriado;
  const tablaLiqHTML = !Object.keys(liq).length
    ? '<p style="color:#666">Sin horas liquidables (sabado/domingo/feriado) con Fecha HE en ' + per + '.</p>'
    : '<table style="border-collapse:collapse;width:100%;font-size:13px">' +
      '<tr style="background:#7B2233;color:#fff"><th align="left">Supervisor</th>' +
      '<th align="right">Sab/Dom</th><th align="right">Feriado</th><th align="right">Total</th></tr>' +
      filasLiq +
      '<tr style="font-weight:bold;background:#F2EDE4"><td>TOTAL</td>' +
      '<td align="right">' + _fmtHoras(liqTotalSabDom) + '</td>' +
      '<td align="right">' + _fmtHoras(liqTotalFeriado) + '</td>' +
      '<td align="right">' + _fmtHoras(liqTotalGeneral) + '</td></tr></table>';

  // Canjes del mes (por Fecha solicitada): compensaciones Aprobadas con
  // fecha en el mes del resumen, agrupadas por supervisor. Se informan
  // aparte: no se suman ni se restan a las horas extra.
  const canjes = _leerCanjes();
  // Un canje aprobado con fecha ilegible descuenta saldo pero no cae en ningun
  // mes: sin este contador desapareceria del resumen en silencio.
  const cjSinFecha = canjes.filter(function (c) { return c.estado === 'Aprobada' && !c.partes; }).length;
  const porSup = {};
  let cjTotalHoras = 0, cjTotalDias = 0, cjPendientes = 0;
  canjes.forEach(function (c) {
    if (!c.partes || c.partes.anio !== anioIni || c.partes.mes !== mesIni) return;
    if (c.estado === 'Pendiente') { cjPendientes++; return; }
    if (c.estado !== 'Aprobada') return;
    if (!porSup[c.supervisor]) porSup[c.supervisor] = { horas: 0, fechas: {} };
    porSup[c.supervisor].horas += c.horas;
    porSup[c.supervisor].fechas[_numPartes(c.partes)] = c.partes;
    cjTotalHoras += c.horas;
  });
  let filasCj = '';
  Object.keys(porSup).sort().forEach(function (n) {
    const claves = Object.keys(porSup[n].fechas).map(Number).sort(function (a, b) { return a - b; });
    const textoFechas = claves.map(function (k) {
      const p = porSup[n].fechas[k];
      return _pad2(p.dia) + '/' + _pad2(p.mes);
    }).join(', ');
    cjTotalDias += claves.length;
    filasCj += '<tr><td>' + _escHtml(n) + '</td><td style="text-align:right">' + claves.length +
               '</td><td style="text-align:right">' + _fmtHoras(porSup[n].horas) +
               '</td><td>' + _escHtml(textoFechas) + '</td></tr>';
  });
  const tablaCanjesHTML = !Object.keys(porSup).length
    ? '<p style="color:#666">Sin canjes aprobados con fecha en ' + _escHtml(per) + '.</p>'
    : '<table style="border-collapse:collapse;width:100%;font-size:13px">' +
      '<tr style="background:#7B2233;color:#fff"><th align="left">Supervisor</th>' +
      '<th align="right">Dias</th><th align="right">Horas</th><th align="left">Fechas</th></tr>' +
      filasCj +
      '<tr style="font-weight:bold;background:#F2EDE4"><td>TOTAL</td>' +
      '<td align="right">' + cjTotalDias + '</td>' +
      '<td align="right">' + _fmtHoras(cjTotalHoras) + '</td><td></td></tr></table>';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:640px">' +
    '<h2 style="color:#7B2233;margin-bottom:4px">Resumen de Horas Extra - ' + per + '</h2>' +
    '<p style="color:#666;margin-top:0">' + CONFIG.NOMBRE_PLANTA + '</p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:13px">' +
    '<tr style="background:#7B2233;color:#fff"><th align="left">Supervisor</th>' +
    '<th align="right">HE del mes</th><th align="right">Saldo compensable</th></tr>' +
    filas +
    '<tr style="font-weight:bold;background:#F2EDE4"><td>TOTAL</td>' +
    '<td align="right">' + _fmtHoras(total) + '</td><td></td></tr></table>' +
    (pend ? '<p style="color:#B00020">Solicitudes pendientes de aprobacion: ' + pend + '</p>' : '') +
    '<h2 style="color:#7B2233;margin:24px 0 4px;font-size:16px">Liquidacion del mes (por Fecha HE)</h2>' +
    '<p style="color:#666;margin-top:0;font-size:12px">Horas de sabado, domingo o feriado ' +
    'TRABAJADAS en ' + per + ' (segun "Fecha HE", no segun cuando se cargo la solicitud).</p>' +
    tablaLiqHTML +
    '<h2 style="color:#7B2233;margin:24px 0 4px;font-size:16px">Canjes del mes (por Fecha solicitada)</h2>' +
    '<p style="color:#666;margin-top:0;font-size:12px">Compensaciones aprobadas con fecha de canje en ' +
    _escHtml(per) + '.</p>' +
    tablaCanjesHTML +
    (cjPendientes ? '<p style="color:#B00020">Canjes pendientes de aprobacion con fecha en ' +
      _escHtml(per) + ': ' + cjPendientes + '</p>' : '') +
    (cjSinFecha ? '<p style="color:#B00020">Canjes aprobados con fecha ilegible (no se pueden ubicar en ' +
      'ningun mes, pero si descuentan saldo): ' + cjSinFecha + '</p>' : '') +
    '<p style="font-size:11px;color:#999;margin-top:10px">Liquidable segun hoja Feriados al momento ' +
    'de este resumen. Politica FLC-DOC-RH-092, vigencia ' + CONFIG.VIGENCIA_LIQUIDACION + '.</p>' +
    '<p style="font-size:11px;color:#999">Los canjes se informan aparte: no se suman ni se restan ' +
    'a las horas extra de este resumen.</p>' +
    '</div>';

  const opciones = { to: jefeEmail(), subject: 'Resumen mensual de Horas Extra - ' + per, htmlBody: html };
  if (!op.soloJefe) {
    const cc = personasEmails();
    if (cc) opciones.cc = cc;
  }
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

  // Mas nuevo primero. El ID trae la fecha-hora DESPUES del prefijo (HE-/CP-):
  // se compara sin el prefijo, si no todas las HE ('HE-' > 'CP-') saldrian
  // antes que todos los canjes.
  lista.sort(function (a, b) { return String(a.id).slice(3) < String(b.id).slice(3) ? 1 : -1; });
  return lista;
}

/** Saldo/HE-del-mes de todos los Supervisores activos del directorio, para las vistas de Jefe y Personas. */
function _equipoCompleto() {
  return _directorio()
    .filter(function (p) { return p.rol === 'Supervisor'; })
    .map(function (p) {
      const d = _desgloseHE(p.email);
      const compensadas = _sumaAprobadas(SH.COMP, p.email);
      return {
        nombre: p.nombre,
        email: p.email,
        generadas: d.compensables,
        compensadas: compensadas,
        saldo: d.compensables - compensadas,
        heDelMes: _heDelMes(p.email),
        liqSabDom: d.liqSabDom,
        liqFeriado: d.liqFeriado,
        liqTotal: d.liqTotal
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
  const d = _desgloseHE(yo.email);
  const compensadas = _sumaAprobadas(SH.COMP, yo.email);

  resultado.misSolicitudes = _filasDe(SH.SOL, yo.email).map(function (f) {
    return {
      id: f.ID, fecha: _fmtFecha(f['Fecha HE']), horas: parseFloat(f.Horas) || 0,
      linea: f.Linea, motivo: f.Motivo, estado: f.Estado,
      // Texto ya normalizado para precargar un formulario de edicion (no es
      // un Date: google.script.run los serializa con corrimiento de zona).
      fechaClave: _clavePartes(_partesFecha(f['Fecha HE']))
    };
  }).sort(function (a, b) { return a.id < b.id ? 1 : -1; });

  resultado.misCompensaciones = _filasDe(SH.COMP, yo.email).map(function (f) {
    const horasCanje = parseFloat(f['Horas a compensar']) || 0;
    return {
      id: f.ID, fecha: _fmtFecha(f['Fecha solicitada']), horas: horasCanje,
      tipo: f.Tipo, estado: f.Estado,
      fechaClave: _clavePartes(_partesFecha(f['Fecha solicitada'])),
      tipoClave: _tipoClaveCanje(f.Tipo, horasCanje)
    };
  }).sort(function (a, b) { return a.id < b.id ? 1 : -1; });

  // NO renombrar generadas/compensadas/disponible: el cliente los usa por
  // nombre en varios lugares. "generadas" ahora es solo COMPENSABLE (ver
  // _desgloseHE/circuitoHE); liqSabDom/liqFeriado/liqTotal son campos
  // nuevos, aditivos.
  resultado.saldo = {
    generadas: d.compensables, compensadas: compensadas, disponible: d.compensables - compensadas,
    liqSabDom: d.liqSabDom, liqFeriado: d.liqFeriado, liqTotal: d.liqTotal
  };
  resultado.politica = { vigencia: CONFIG.VIGENCIA_LIQUIDACION };
  // Un solo flag de permisos: el cliente decide pestañas y botones por esto y
  // no por el texto del rol (ver _puedeAdministrar).
  resultado.permisos = { administrar: _puedeAdministrar(yo) };

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
      saldoTotal: equipo.reduce(function (acc, p) { return acc + p.saldo; }, 0),
      liqTotal: equipo.reduce(function (acc, p) { return acc + p.liqTotal; }, 0)
    };
  }

  return resultado;
}

// ==================== VALIDACIONES COMPARTIDAS (alta y edicion) ====================
/**
 * Horas de una hora extra tipeadas por una persona: numero entre 0,5 y 24
 * (acepta coma decimal). Fuente unica para apiCrearHoraExtra y la edicion.
 * @returns {number}
 */
function _horasHEValidas(valor) {
  const horas = parseFloat(String(valor == null ? '' : valor).replace(',', '.'));
  if (!horas || horas < 0.5 || horas > 24) {
    throw new Error('La cantidad de horas tiene que ser un numero entre 0,5 y 24.');
  }
  return horas;
}

/** Linea de una hora extra: tiene que ser una de LINEAS_VALIDAS. @returns {string} */
function _lineaValida(valor) {
  const linea = String(valor || '').trim();
  if (LINEAS_VALIDAS.indexOf(linea) === -1) {
    throw new Error('Linea invalida: elegi L1, L2, L3 o Varias.');
  }
  return linea;
}

/**
 * Tipo y horas de un canje a partir de lo que manda el cliente. El tipo lo
 * manda el cliente pero las HORAS las calcula el SERVIDOR a partir del tipo
 * (nunca confiamos en un numero que mande el cliente para dia completo o medio
 * dia: dejaria manipular el saldo con un payload armado a mano).
 * @returns {{tipo:string, horas:number, tipoClave:string}}
 */
function _tipoYHorasCanje(tipoCrudo, horasCrudas) {
  const t = String(tipoCrudo || '').trim().toLowerCase();
  if (t === 'medio') {
    return { tipo: 'Medio dia', horas: CONFIG.HORAS_POR_DIA / 2, tipoClave: 'medio' };
  }
  if (t === 'completo') {
    return { tipo: 'Dia completo', horas: CONFIG.HORAS_POR_DIA, tipoClave: 'completo' };
  }
  if (t === 'personalizado') {
    // Unico caso donde la cantidad la elige el usuario. En dia completo y
    // medio dia la calcula el servidor y se ignora cualquier numero que
    // mande el cliente, para que no se pueda tocar el saldo con un pedido
    // armado a mano.
    const horas = Number(horasCrudas);
    if (!isFinite(horas) || !Number.isInteger(horas) || horas < 1) {
      throw new Error('La cantidad de horas tiene que ser un numero entero de 1 hora o mas.');
    }
    if (horas > 24 * 30) {
      throw new Error('La cantidad de horas es demasiado alta. Revisala.');
    }
    return { tipo: 'Horas sueltas', horas: horas, tipoClave: 'personalizado' };
  }
  throw new Error('Tipo de compensacion invalido.');
}

/**
 * Clave de radio ('completo' | 'medio' | 'personalizado') de un canje YA
 * guardado. Incluye las filas del Form, con texto libre en Tipo: si las horas
 * no son las del dia (o del medio dia), es "personalizado" aunque el texto
 * diga "Dia completo".
 */
function _tipoClaveCanje(tipoTexto, horas) {
  const esMedio = String(tipoTexto || '').toUpperCase().indexOf('MEDIO') >= 0;
  if (horas === CONFIG.HORAS_POR_DIA && !esMedio) return 'completo';
  if (horas === CONFIG.HORAS_POR_DIA / 2 && esMedio) return 'medio';
  return 'personalizado';
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

  const horas = _horasHEValidas(payload.horas);
  const linea = _lineaValida(payload.linea);

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

  const th = _tipoYHorasCanje(payload.tipo, payload.horas);
  const tipo = th.tipo, horas = th.horas;

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

/**
 * Extrae {anio, mes, dia} (mes 1-12) de un valor de "Fecha HE" que puede
 * venir como Date real o como texto en formatos distintos: dd/MM/yyyy (lo
 * que escribe un supervisor a mano, o lo que devuelve _fmtFecha), yyyy-MM-dd
 * (ISO, lo que manda un <input type="date"> ya convertido), o cualquier otra
 * cosa que el motor de fechas de JS pueda interpretar como ultimo recurso.
 * Devuelve null si no se pudo interpretar nada.
 */
function _partesFecha(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return { anio: v.getFullYear(), mes: v.getMonth() + 1, dia: v.getDate() };
  }
  const s = String(v || '').trim();
  if (!s) return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return { anio: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]) };

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return { anio: Number(m[3]), mes: Number(m[2]), dia: Number(m[1]) };

  const d = new Date(s);
  if (!isNaN(d.getTime())) return { anio: d.getFullYear(), mes: d.getMonth() + 1, dia: d.getDate() };

  return null;
}

/**
 * Datos para la tarjeta "Calendario": dias del mes con horas extra
 * cargadas (hoja Solicitudes), con el detalle de cada solicitud de ese
 * dia. Filtra SIEMPRE por "Fecha HE" (el dia en que se hicieron las
 * horas), NUNCA por Timestamp (el dia en que se cargaron): a quien mira
 * el calendario le importa cuando paso, no cuando se anoto.
 *
 * Alcance por rol, filtrado en el SERVIDOR — nunca por un parametro que
 * mande el cliente, asi que un Supervisor no puede ver datos de otro
 * mandando otro anio/mes (esos parametros solo eligen el mes, no de quien
 * son los datos):
 *  - Jefe y Personas: todas las solicitudes del mes.
 *  - Supervisor: solo las propias.
 *
 * El numero de cada dia y el total del mes cuentan SOLO horas Aprobadas.
 * Las Pendientes viajan aparte (horasPendientes/totalPendientes/
 * horasPendientes por supervisor) y el cliente las muestra subordinadas,
 * nunca sumadas al numero principal. Las Rechazadas no suman a ningun
 * total, pero SI aparecen en el `detalle` de su dia: el Jefe quiere ver
 * que paso, no un recorte. Las Anuladas y las Retiradas NO aparecen: se
 * excluyen por completo (siguen en Consulta).
 *
 * Los CANJES (compensaciones) viajan aparte, en `canjes`/`proximosCanjes` y
 * los totales `*Canje*`: NO se meten en `dias`, porque un dia solo-canje
 * quedaria con 0/0 horas y el cliente lo pintaria como rechazado. Solo
 * entran Aprobados y Pendientes (sirven para ver la cobertura del turno).
 *
 * @param {number|string} [anio]
 * @param {number|string} [mes] 1-12
 */
function apiCalendario(anio, mes) {
  const yo = _identificar();

  const hoy = new Date();
  let anioNum = parseInt(anio, 10);
  let mesNum = parseInt(mes, 10);
  if (!Number.isInteger(anioNum) || anioNum < 2000 || anioNum > 2100) {
    anioNum = Number(Utilities.formatDate(hoy, CONFIG.TZ, 'yyyy'));
  }
  if (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
    mesNum = Number(Utilities.formatDate(hoy, CONFIG.TZ, 'M'));
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const d = ss.getSheetByName(SH.SOL).getDataRange().getValues();

  const dias = {};
  let totalAprobadas = 0, totalPendientes = 0, totalAprobadasLiq = 0, totalAprobadasComp = 0;
  const porSupervisorMapa = {};

  if (d.length >= 2) {
    const enc = d[0];
    const cId = _idx(enc, 'ID'), cSup = _idx(enc, 'Supervisor'), cEmail = _idx(enc, 'Email'),
          cFecha = _idx(enc, 'Fecha HE'), cHoras = _idx(enc, 'Horas'), cLinea = _idx(enc, 'Linea'),
          cMotivo = _idx(enc, 'Motivo'), cEstado = _idx(enc, 'Estado');

    for (let i = 1; i < d.length; i++) {
      const partes = _partesFecha(d[i][cFecha]);
      if (!partes || partes.anio !== anioNum || partes.mes !== mesNum) continue;
      if (yo.rol === 'Supervisor' && _normEmail(d[i][cEmail]) !== yo.email) continue;

      const estado = d[i][cEstado];
      // Anulada y Retirada no tienen efecto ni se ven en el calendario: un dia
      // con solo una anulada quedaria pintado como "rechazado". Tiene que ir
      // ANTES de crear dias[partes.dia]. El historial esta en Consulta.
      if (estado === 'Anulada' || estado === 'Retirada') continue;
      const horas = parseFloat(d[i][cHoras]) || 0;
      const supervisor = d[i][cSup];
      const c = circuitoHE(d[i][cFecha]);

      if (!dias[partes.dia]) {
        dias[partes.dia] = {
          dia: partes.dia, horasAprobadas: 0, horasPendientes: 0, detalle: [],
          // Propiedad del DIA, no de una solicitud puntual: todas las filas
          // de este mismo dia comparten fecha, asi que tipoDia/feriadoNombre/
          // liquidable son iguales para cualquiera de ellas.
          tipoDia: c.tipo, feriadoNombre: c.feriadoNombre, liquidable: (c.circuito === 'LIQ')
        };
      }
      const acc = dias[partes.dia];

      acc.detalle.push({
        id: d[i][cId], supervisor: supervisor, horas: horas,
        linea: d[i][cLinea], motivo: d[i][cMotivo], estado: estado
      });

      if (estado === 'Aprobada') {
        acc.horasAprobadas += horas;
        totalAprobadas += horas;
        if (c.circuito === 'LIQ') totalAprobadasLiq += horas; else totalAprobadasComp += horas;
        if (!porSupervisorMapa[supervisor]) porSupervisorMapa[supervisor] = { horasAprobadas: 0, horasPendientes: 0, horasLiq: 0 };
        porSupervisorMapa[supervisor].horasAprobadas += horas;
        if (c.circuito === 'LIQ') porSupervisorMapa[supervisor].horasLiq += horas;
      } else if (estado === 'Pendiente') {
        acc.horasPendientes += horas;
        totalPendientes += horas;
        if (!porSupervisorMapa[supervisor]) porSupervisorMapa[supervisor] = { horasAprobadas: 0, horasPendientes: 0, horasLiq: 0 };
        porSupervisorMapa[supervisor].horasPendientes += horas;
      }
      // Rechazada: ya quedo en el detalle de arriba; no suma a ningun total, a proposito.
    }
  }

  const diasArray = Object.keys(dias).map(function (k) {
    const acc = dias[k];
    return {
      dia: acc.dia, horasAprobadas: acc.horasAprobadas,
      horasPendientes: acc.horasPendientes, detalle: acc.detalle,
      tipoDia: acc.tipoDia, feriadoNombre: acc.feriadoNombre, liquidable: acc.liquidable
    };
  }).sort(function (a, b) { return a.dia - b.dia; });

  const porSupervisorArray = Object.keys(porSupervisorMapa).map(function (nombre) {
    return {
      nombre: nombre,
      horasAprobadas: porSupervisorMapa[nombre].horasAprobadas,
      horasPendientes: porSupervisorMapa[nombre].horasPendientes,
      horasLiq: porSupervisorMapa[nombre].horasLiq
    };
  }).sort(function (a, b) { return b.horasAprobadas - a.horasAprobadas; });

  // Feriados del mes segun la hoja "Feriados", con o sin solicitudes
  // cargadas ese dia: el cliente los usa para marcar la celda con el badge
  // "F" aunque nadie haya pedido horas extra ese dia.
  const feriadosMes = [];
  const mapaFeriados = _feriadosMap();
  Object.keys(mapaFeriados).forEach(function (clave) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clave);
    if (!m) return;
    if (Number(m[1]) === anioNum && Number(m[2]) === mesNum) {
      feriadosMes.push({ dia: Number(m[3]), nombre: mapaFeriados[clave] });
    }
  });
  feriadosMes.sort(function (a, b) { return a.dia - b.dia; });

  // ---- Canjes (aditivo) ----
  const mapaNombres = _mapaNombres();
  const canjesVisibles = _leerCanjes().filter(function (c) {
    if (c.estado !== 'Aprobada' && c.estado !== 'Pendiente') return false;
    return yo.rol !== 'Supervisor' || c.email === yo.email;
  });
  const cmpCanje = function (a, b, ka, kb) {
    if (ka !== kb) return ka - kb;
    return a.supervisor < b.supervisor ? -1 : (a.supervisor > b.supervisor ? 1 : 0);
  };

  let totalCanjeAprobadas = 0, cantCanjeAprobados = 0, totalCanjePendientes = 0, cantCanjePendientes = 0;
  const canjesMes = [];
  canjesVisibles.forEach(function (c) {
    if (!c.partes || c.partes.anio !== anioNum || c.partes.mes !== mesNum) return;
    if (c.estado === 'Aprobada') { totalCanjeAprobadas += c.horas; cantCanjeAprobados++; }
    else { totalCanjePendientes += c.horas; cantCanjePendientes++; }
    canjesMes.push({
      id: c.id, dia: c.partes.dia, supervisor: c.supervisor,
      iniciales: _iniciales(c.supervisor || mapaNombres[c.email]),
      horas: c.horas, tipoCanje: c.tipo, estado: c.estado
    });
  });
  canjesMes.sort(function (a, b) { return cmpCanje(a, b, a.dia, b.dia); });

  // Esta semana y la siguiente (lunes a domingo, 14 dias) segun "hoy" del
  // servidor, sin importar el mes que se esta mirando. Aritmetica UTC.
  const hp = _hoyPartes();
  const hoyUTC = Date.UTC(hp.anio, hp.mes - 1, hp.dia);
  const dowHoy = new Date(hoyUTC).getUTCDay();
  const desde = _partesDeUTC(hoyUTC - ((dowHoy + 6) % 7) * 86400000);
  const hasta = _partesDeUTC(hoyUTC - ((dowHoy + 6) % 7) * 86400000 + 13 * 86400000);
  const numDesde = _numPartes(desde), numHasta = _numPartes(hasta);
  const proximos = [];
  canjesVisibles.forEach(function (c) {
    if (!c.partes) return;
    const n = _numPartes(c.partes);
    if (n < numDesde || n > numHasta) return;
    proximos.push({ n: n, fechaClave: _clavePartes(c.partes), supervisor: c.supervisor, estado: c.estado });
  });
  proximos.sort(function (a, b) { return cmpCanje(a, b, a.n, b.n); });
  const proximosCanjes = proximos.map(function (x) {
    return { fechaClave: x.fechaClave, supervisor: x.supervisor, estado: x.estado };
  });

  return {
    anio: anioNum, mes: mesNum, dias: diasArray,
    totalAprobadas: totalAprobadas, totalPendientes: totalPendientes,
    totalAprobadasLiq: totalAprobadasLiq, totalAprobadasComp: totalAprobadasComp,
    porSupervisor: porSupervisorArray,
    feriados: feriadosMes, vigencia: CONFIG.VIGENCIA_LIQUIDACION,
    canjes: canjesMes,
    totalCanjeAprobadas: totalCanjeAprobadas, cantCanjeAprobados: cantCanjeAprobados,
    totalCanjePendientes: totalCanjePendientes, cantCanjePendientes: cantCanjePendientes,
    proximosCanjes: proximosCanjes
  };
}

/**
 * Datos para el panel de consulta con filtros (Jefe y Personas): TODAS las
 * solicitudes de horas extra (hoja Solicitudes), con la fecha desglosada
 * en partes, para que el cliente filtre por supervisor/mes/semana ISO/
 * estado/linea sin ida y vuelta al servidor por cada cambio de filtro.
 *
 * Alcance por rol, filtrado en el SERVIDOR — mismo patron que
 * apiCalendario (linea por linea):
 *  - Jefe y Personas: todas las filas.
 *  - Supervisor: solo las propias.
 * Los 4 filtros del panel son presentacion sobre datos que el rol ya tiene
 * derecho a ver completos; con ~28 filas por mes, filtrar en el cliente da
 * respuesta instantanea en vez de un round-trip de 0,5-2s por cada cambio
 * de filtro. El cliente NUNCA recibe una fila que su rol no pueda ver. Si
 * esta hoja algun dia supera ~2000 filas, agregar un parametro anio para
 * no traer todo el historico de una.
 *
 * Devuelve ademas los CANJES (hoja Compensaciones, aprobados, pendientes y
 * rechazados) en `canjes`, con el mismo alcance por rol. Un canje no tiene
 * Linea ni tipo de dia ni circuito: el cliente los muestra aparte y NUNCA
 * los suma a las horas extra.
 *
 * NO devuelve objetos Date: google.script.run los serializa con corrimiento
 * de zona horaria. Se manda {anio,mes,dia} (via _partesFecha, null si la
 * fecha no se pudo interpretar) mas un texto ya formateado (via _fmtFecha)
 * solo para mostrar. NO devuelve email ni token: no le hacen falta al
 * cliente y el token jamas tiene que salir del mail de aprobacion.
 *
 * @returns {{solicitudes: Array, canjes: Array}}
 */
function apiConsulta() {
  const yo = _identificar();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const d = ss.getSheetByName(SH.SOL).getDataRange().getValues();

  const solicitudes = [];
  if (d.length >= 2) {
    const enc = d[0];
    const cId = _idx(enc, 'ID'), cSup = _idx(enc, 'Supervisor'), cEmail = _idx(enc, 'Email'),
          cFecha = _idx(enc, 'Fecha HE'), cHoras = _idx(enc, 'Horas'), cLinea = _idx(enc, 'Linea'),
          cMotivo = _idx(enc, 'Motivo'), cEstado = _idx(enc, 'Estado');

    for (let i = 1; i < d.length; i++) {
      if (yo.rol === 'Supervisor' && _normEmail(d[i][cEmail]) !== yo.email) continue;

      const c = circuitoHE(d[i][cFecha]);
      solicitudes.push({
        // editable: el cliente muestra "Editar" solo si el servidor lo permite
        // (Jefe, y no si la saco el autor). Un Supervisor siempre recibe false.
        editable: _puedeAdministrar(yo, { Email: d[i][cEmail], Estado: d[i][cEstado] }) && d[i][cEstado] !== 'Retirada',
        id: d[i][cId],
        supervisor: d[i][cSup],
        fecha: _partesFecha(d[i][cFecha]),
        fechaTexto: _fmtFecha(d[i][cFecha]),
        horas: parseFloat(d[i][cHoras]) || 0,
        linea: d[i][cLinea],
        motivo: d[i][cMotivo],
        estado: d[i][cEstado],
        tipoDia: c.tipo,
        circuito: c.circuito
      });
    }
  }

  const canjes = _leerCanjes()
    .filter(function (c) { return yo.rol !== 'Supervisor' || c.email === yo.email; })
    .map(function (c) {
      return {
        id: c.id, supervisor: c.supervisor, fecha: c.partes, fechaTexto: c.fechaTexto,
        horas: c.horas, tipoCanje: c.tipo, estado: c.estado, comentario: c.comentario,
        editable: _puedeAdministrar(yo, { Email: c.email, Estado: c.estado }) && c.estado !== 'Retirada'
      };
    });

  return { solicitudes: solicitudes, canjes: canjes };
}

// ==================== ADMINISTRACION: EDICION DEL JEFE ====================
/**
 * Un solo punto de permisos para administrar (editar/anular) una solicitud o
 * un canje. Hoy solo el Jefe, y administra todo. Enganche para el futuro
 * (areas, rol Administrador): aca entra la condicion por area. Lo usan
 * apiAdminDetalle/apiAdminEditar/apiAdminActividad y el `editable` de
 * apiConsulta; el cliente solo mira `permisos.administrar` y `editable`.
 * `fila` ({Email, Estado}) puede ser undefined (permiso general).
 */
function _puedeAdministrar(yo, fila) {
  if (!yo || yo.rol !== 'Jefe') return false;
  // Decision del Jefe: lo PROPIO no se edita. Nadie corrige, re-aprueba ni
  // sube sus propias horas o canjes desde el panel: el control cruzado queda
  // para Personas o el futuro Administrador.
  if (fila && _normEmail(fila.Email) === _normEmail(yo.email)) return false;
  return true;
}

/**
 * Corre fn dentro del lock de script, con el mismo mensaje de "ocupado" que
 * apiResolver. Siempre libera el lock.
 */
function _conLock(fn) {
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
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Busca una fila por ID (HE-... en Solicitudes, CP-... en Compensaciones).
 * Lee la hoja UNA vez.
 * @returns {{sh:Object, enc:string[], fila:Array, filaHoja:number, esComp:boolean, id:string}}
 *   filaHoja es 1-based (numero de fila en la hoja).
 */
function _buscarFila(id) {
  id = String(id || '').trim();
  const esComp = id.indexOf('CP-') === 0;
  if (!esComp && id.indexOf('HE-') !== 0) throw new Error('ID invalido.');
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(esComp ? SH.COMP : SH.SOL);
  const data = sh.getDataRange().getValues();
  if (data.length >= 2) {
    const enc = data[0];
    const cId = _idx(enc, 'ID');
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][cId]) === id) {
        return { sh: sh, enc: enc, fila: data[i], filaHoja: i + 1, esComp: esComp, id: id };
      }
    }
  }
  throw new Error('No se encontro la solicitud.');
}

/**
 * Defensa antes de escribir: relee la celda ID de la fila y exige que siga
 * siendo la misma. Las filas nunca se borran, pero alguien puede ordenar la
 * hoja a mano entre la lectura y la escritura.
 */
function _verificarFila(ref) {
  const actual = ref.sh.getRange(ref.filaHoja, _idx(ref.enc, 'ID') + 1).getValue();
  if (String(actual) !== ref.id) throw new Error('La hoja cambio de orden. Volve a intentar.');
}

/** Escribe UNA celda de la fila, por nombre de columna. */
function _setCelda(ref, nombreCol, valor) {
  ref.sh.getRange(ref.filaHoja, _idx(ref.enc, nombreCol) + 1).setValue(_celdaSegura(valor));
}

/**
 * Texto tipeado por personas que empieza con = + - o @ Sheets lo toma como
 * formula: "=HYPERLINK(...)" quedaria vivo en la planilla y "-revisar" termina
 * en #ERROR!. Con un apostrofe adelante queda como texto literal (el apostrofe
 * no se ve en la celda). Numeros y fechas pasan sin tocar.
 */
function _celdaSegura(v) {
  return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v;
}

/**
 * Valores de negocio normalizados de una fila, para comparar y mostrar.
 * HE:  {estado, fechaClave, fechaTexto, horas, linea, motivo, email, supervisor}
 * CP:  {estado, fechaClave, fechaTexto, horas, tipo, tipoClave, email, supervisor}
 * fechaClave es 'yyyy-MM-dd' o null si la fecha no se pudo interpretar.
 */
function _valoresFila(ref) {
  const g = function (nombre) { return ref.fila[_idx(ref.enc, nombre)]; };
  const crudaFecha = g(ref.esComp ? 'Fecha solicitada' : 'Fecha HE');
  const v = {
    estado: String(g('Estado') == null ? '' : g('Estado')),
    fechaClave: _clavePartes(_partesFecha(crudaFecha)),
    fechaTexto: _fmtFecha(crudaFecha),
    email: _normEmail(g('Email')),
    supervisor: String(g('Supervisor') == null ? '' : g('Supervisor')).trim()
  };
  if (ref.esComp) {
    v.horas = parseFloat(g('Horas a compensar')) || 0;
    v.tipo = String(g('Tipo') == null ? '' : g('Tipo')).trim();
    v.tipoClave = _tipoClaveCanje(v.tipo, v.horas);
  } else {
    v.horas = parseFloat(g('Horas')) || 0;
    v.linea = String(g('Linea') == null ? '' : g('Linea')).trim();
    v.motivo = String(g('Motivo') == null ? '' : g('Motivo')).trim();
  }
  return v;
}

/**
 * Huella de concurrencia: MD5 (base64) de los valores de negocio de la fila,
 * SIN el token. apiAdminDetalle la entrega y apiAdminEditar la exige adentro
 * del lock: si alguien cambio la fila mientras el Jefe tenia el modal abierto,
 * no coincide y no se escribe nada.
 */
function _huella(v, esComp) {
  const partes = esComp
    ? [v.estado, v.fechaClave || v.fechaTexto, v.horas, v.tipo]
    : [v.estado, v.fechaClave || v.fechaTexto, v.horas, v.linea, v.motivo];
  const s = partes.join('␟');
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8));
}

/**
 * Mes anterior al actual que toca un cambio, o null. Sirve para avisar que se
 * esta tocando algo de un mes que puede estar ya liquidado (todavia no hay
 * cierre de mes que lo impida). Compara con _hoyPartes() (CONFIG.TZ).
 * @param {Array<{anio:number,mes:number,dia:number}|null>} partesLista
 * @returns {string|null} "julio 2026" (el mas viejo), o null
 */
function _mesAnteriorAfectado(partesLista) {
  const hoy = _hoyPartes();
  const numHoy = hoy.anio * 100 + hoy.mes;
  let masViejo = null;
  partesLista.forEach(function (p) {
    if (!p) return;
    const n = p.anio * 100 + p.mes;
    if (n < numHoy && (masViejo === null || n < masViejo.n)) masViejo = { n: n, anio: p.anio, mes: p.mes };
  });
  return masViejo ? _MESES_MIN[masViejo.mes - 1] + ' ' + masViejo.anio : null;
}

/** Texto de Auditoria: 'Estado: Aprobada -> Anulada; Horas: 3 -> 5' (sin saltos de linea). */
function _textoCambios(cambios) {
  return cambios.map(function (c) {
    return c.campo + ': ' + c.antes + ' -> ' + c.despues;
  }).join('; ').replace(/\s*[\r\n]+\s*/g, ' ');
}

/** Nombre a mostrar de una persona: el del directorio, si no el de la fila. */
function _nombreVisible(email, nombreFila) {
  return _mapaNombres()[email] || nombreFila || 'Sin nombre';
}

/** Date -> 'dd/MM/yyyy HH:mm'; cualquier otra cosa, su texto. */
function _fmtFechaHora(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, CONFIG.TZ, 'dd/MM/yyyy HH:mm');
  }
  return String(v == null ? '' : v).trim();
}

/**
 * Compara los datos que mando el cliente contra los de la fila, campo por
 * campo, y arma SOLO lo que cambio. Se valida solo lo que cambia: una fila
 * cargada por el Form puede traer una fecha como texto, una linea "Envasado" o
 * un canje "Dia completo" con horas que no son 8, y abrir y guardar sin tocar
 * nada NO tiene que convertirla ni dejar un cambio fantasma.
 *
 * No incluye el Estado (lo maneja quien llama).
 * @returns {{cambios:Array, celdas:Object, horas:number, fecha:*, linea:string,
 *            motivo:string, tipo:string}}
 *   celdas: {nombreDeColumna: valorNuevo} solo de lo que cambio.
 *   fecha: valor crudo (Date o el original) para clasificar/simular.
 */
function _calcularCambiosDatos(ref, v, payload) {
  const esComp = ref.esComp;
  const colFecha = esComp ? 'Fecha solicitada' : 'Fecha HE';
  const cambios = [];
  const celdas = {};
  let fecha = ref.fila[_idx(ref.enc, colFecha)];
  let horas = v.horas, linea = v.linea, motivo = v.motivo, tipo = v.tipo;

  const fechaIn = String(payload.fecha == null ? '' : payload.fecha).trim();
  if (fechaIn !== (v.fechaClave || '')) {
    const f = _parsearFechaInput(fechaIn);
    if (!esComp) _validarFechaNoFutura(f);
    fecha = f;
    celdas[colFecha] = f;
    cambios.push({ campo: 'Fecha', antes: v.fechaTexto || '(sin fecha)', despues: _fmtFecha(f) });
  }

  if (!esComp) {
    const horasIn = parseFloat(String(payload.horas == null ? '' : payload.horas).replace(',', '.'));
    if (!(Math.abs(horasIn - v.horas) < 1e-9)) {
      horas = _horasHEValidas(payload.horas);
      celdas['Horas'] = horas;
      cambios.push({ campo: 'Horas', antes: _fmtHoras(v.horas), despues: _fmtHoras(horas) });
    }
    const lineaIn = String(payload.linea == null ? '' : payload.linea).trim();
    if (lineaIn !== v.linea) {
      linea = _lineaValida(lineaIn);
      celdas['Linea'] = linea;
      cambios.push({ campo: 'Linea', antes: v.linea || '(sin linea)', despues: linea });
    }
    const motivoIn = String(payload.motivo == null ? '' : payload.motivo).trim();
    if (motivoIn !== v.motivo) {
      if (!motivoIn) throw new Error('El motivo no puede estar vacio.');
      motivo = motivoIn;
      celdas['Motivo'] = motivo;
      cambios.push({ campo: 'Motivo', antes: v.motivo || '(vacio)', despues: motivo });
    }
  } else {
    const tipoIn = String(payload.tipo == null ? '' : payload.tipo).trim().toLowerCase();
    // Sin cambio de tipo ni de horas: no se toca nada (ni se revalida), asi un
    // canje del Form con horas "raras" se puede abrir y guardar sin tropiezos.
    const igual = tipoIn === v.tipoClave &&
                  (tipoIn !== 'personalizado' || Number(payload.horas) === v.horas);
    if (!igual) {
      const nuevo = _tipoYHorasCanje(payload.tipo, payload.horas);
      if (nuevo.tipo !== v.tipo) {
        tipo = nuevo.tipo;
        celdas['Tipo'] = tipo;
        cambios.push({ campo: 'Tipo', antes: v.tipo || '(sin tipo)', despues: tipo });
      }
      if (nuevo.horas !== v.horas) {
        horas = nuevo.horas;
        celdas['Horas a compensar'] = horas;
        cambios.push({ campo: 'Horas', antes: _fmtHoras(v.horas), despues: _fmtHoras(horas) });
      }
    }
  }
  return { cambios: cambios, celdas: celdas, horas: horas, fecha: fecha, linea: linea, motivo: motivo, tipo: tipo };
}

/**
 * Historial de Auditoria de UN id, mas nuevo primero.
 * @returns {Array<{ts:string, accionTexto:string, usuario:string, detalle:string}>}
 */
function _historialDe(id, max) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH.LOG);
  const out = [];
  if (!sh) return out;
  const d = sh.getDataRange().getValues();
  if (d.length < 2) return out;
  const enc = d[0];
  const cTs = _idx(enc, 'Timestamp'), cId = _idx(enc, 'ID'), cAcc = _idx(enc, 'Accion'),
        cUsu = _idx(enc, 'Usuario'), cDet = _idx(enc, 'Detalle');
  const nombres = _mapaNombres();
  for (let i = d.length - 1; i >= 1 && out.length < max; i--) {
    if (String(d[i][cId]) !== id) continue;
    const acc = String(d[i][cAcc]);
    const usu = String(d[i][cUsu] || '');
    out.push({
      ts: _fmtFechaHora(d[i][cTs]),
      accionTexto: ACCION_TEXTO[acc] || ACCION_TEXTO_HISTORIAL[acc] || acc,
      usuario: nombres[_normEmail(usu)] || usu,
      detalle: String(d[i][cDet] || '')
    });
  }
  return out;
}

/**
 * Detalle fresco de una solicitud o canje para abrir el modal de edicion.
 * SOLO Jefe. Solo lee (sin lock). Nunca devuelve el token: la huella no lo
 * incluye.
 *
 * @param {string} id HE-... o CP-...
 */
function apiAdminDetalle(id) {
  const yo = _identificar(['Jefe']);
  const ref = _buscarFila(id);
  const v = _valoresFila(ref);
  if (!_puedeAdministrar(yo, { Email: v.email, Estado: v.estado })) {
    throw new Error(_normEmail(v.email) === _normEmail(yo.email)
      ? 'Es una solicitud tuya: lo propio no se puede editar desde el panel.'
      : 'No tenes permiso sobre esta solicitud.');
  }

  const nombres = _mapaNombres();
  const cApr = _idx(ref.enc, 'Aprobado por'), cFecApr = _idx(ref.enc, 'Fecha aprobacion');
  const aprPor = String(ref.fila[cApr] || '').trim();
  const retirada = v.estado === 'Retirada';

  const out = {
    id: ref.id,
    mov: ref.esComp ? 'CP' : 'HE',
    estado: v.estado,
    supervisor: nombres[v.email] || v.supervisor,
    fechaClave: v.fechaClave,
    fechaTexto: v.fechaTexto,
    horas: v.horas,
    ultimaDecision: {
      por: aprPor ? (nombres[_normEmail(aprPor)] || aprPor) : '',
      fecha: aprPor ? _fmtFechaHora(ref.fila[cFecApr]) : ''
    },
    huella: _huella(v, ref.esComp),
    editable: !retirada,
    motivoNoEditable: retirada ? 'La retiro el supervisor: no se puede modificar.' : '',
    saldo: { compensable: saldoSupervisor(v.email), liqTotal: _desgloseHE(v.email).liqTotal },
    historial: _historialDe(ref.id, 20)
  };
  if (ref.esComp) {
    out.tipoCanje = v.tipo;
    out.tipoClave = v.tipoClave;
  } else {
    const c = circuitoHE(ref.fila[_idx(ref.enc, 'Fecha HE')]);
    out.linea = v.linea;
    out.motivo = v.motivo;
    out.circuito = c.circuito;
    out.tipoDia = c.tipo;
  }
  return out;
}

/**
 * Previsualiza (confirmar=false) o guarda (confirmar=true) un cambio del Jefe
 * sobre una solicitud o canje, en cualquier estado salvo Retirada. SOLO Jefe.
 * Todo adentro del lock. Se repite TODO en confirmar=true (huella, validaciones
 * y descubierto): la previsualizacion no es una promesa.
 *
 * Los numeros del resumen salen de saldoSupervisor/_desgloseHE con `simular`
 * (la misma regla que el saldo real): el cliente no calcula plata.
 *
 * Al guardar: escribe solo lo que cambio, regenera el Token (los links de
 * mails anteriores dejan de valer), deja Auditoria con antes/despues y motivo,
 * y manda mail al supervisor con copia a Personas. Si queda Pendiente, le
 * reenvia al Jefe el mail de aprobacion con el token nuevo. Los mails van
 * DESPUES de escribir, cada uno en su try/catch: si fallan, el cambio queda.
 *
 * @param {{id:string, huella:string, estado:string, fecha:string, horas:(number|string),
 *          linea:string, motivo:string, tipo:string, motivoCambio:string,
 *          confirmar:boolean, aceptarDescubierto:boolean}} payload
 */
function apiAdminEditar(payload) {
  const yo = _identificar(['Jefe']);
  payload = payload || {};

  const motivoCambio = String(payload.motivoCambio == null ? '' : payload.motivoCambio).trim();
  if (!motivoCambio) throw new Error('Escribi el motivo del cambio.');
  if (motivoCambio.length > 500) throw new Error('El motivo del cambio es demasiado largo (maximo 500).');

  return _conLock(function () {
    const ref = _buscarFila(payload.id);
    const v = _valoresFila(ref);
    if (!_puedeAdministrar(yo, { Email: v.email, Estado: v.estado })) {
      throw new Error(_normEmail(v.email) === _normEmail(yo.email)
      ? 'Es una solicitud tuya: lo propio no se puede editar desde el panel.'
      : 'No tenes permiso sobre esta solicitud.');
    }
    if (v.estado === 'Retirada') throw new Error('La retiro el supervisor: no se puede modificar.');
    if (_huella(v, ref.esComp) !== String(payload.huella || '')) {
      throw new Error('La solicitud cambio mientras la editabas. Cerrá y volvé a abrirla.');
    }

    const nuevoEstado = String(payload.estado == null ? '' : payload.estado);
    if (ESTADOS_EDITABLES_JEFE.indexOf(nuevoEstado) === -1) throw new Error('Estado invalido.');

    const datos = _calcularCambiosDatos(ref, v, payload);
    const cambios = datos.cambios.slice();
    const estadoCambio = nuevoEstado !== v.estado;
    if (estadoCambio) cambios.unshift({ campo: 'Estado', antes: v.estado || '(vacio)', despues: nuevoEstado });
    if (!cambios.length) throw new Error('No hay cambios para guardar.');

    // Antes / despues con la fuente unica de plata.
    const sim = { id: ref.id, estado: nuevoEstado, horas: datos.horas, fecha: datos.fecha };
    const r2 = function (n) { return Math.round(n * 100) / 100; };
    const saldoAntes = r2(saldoSupervisor(v.email));
    const saldoDespues = r2(saldoSupervisor(v.email, sim));
    const liqAntes = r2(_desgloseHE(v.email).liqTotal);
    const liqDespues = r2(_desgloseHE(v.email, sim).liqTotal);
    const descubierto = saldoDespues < 0 && saldoDespues < saldoAntes;

    let circuito = null;
    if (!ref.esComp) {
      const cAntes = circuitoHE(ref.fila[_idx(ref.enc, 'Fecha HE')]).circuito;
      const cDespues = circuitoHE(datos.fecha).circuito;
      if (cAntes !== cDespues) circuito = { antes: cAntes, despues: cDespues };
    }

    // Aviso de mes anterior (D9): solo si hay una Aprobada de por medio.
    let mesAnterior = null;
    if (v.estado === 'Aprobada' || nuevoEstado === 'Aprobada') {
      mesAnterior = _mesAnteriorAfectado([_partesFecha(ref.fila[_idx(ref.enc, ref.esComp ? 'Fecha solicitada' : 'Fecha HE')]),
                                          _partesFecha(datos.fecha)]);
    }

    const nombre = _nombreVisible(v.email, v.supervisor);
    const pers = personasEmails();
    const resumen = {
      id: ref.id,
      mov: ref.esComp ? 'CP' : 'HE',
      supervisor: nombre,
      cambios: cambios,
      saldo: { antes: saldoAntes, despues: saldoDespues },
      liq: { antes: liqAntes, despues: liqDespues },
      circuito: circuito,
      descubierto: descubierto,
      mesAnterior: mesAnterior,
      quedaPendiente: nuevoEstado === 'Pendiente',
      avisaA: { supervisor: nombre, personas: pers ? pers.split(',').length : 0,
                // Si el dueño no tiene correo real, la vista previa no promete un mail que no va a salir.
                mailOk: !!v.email && !_esEmailPlaceholder(v.email) },
      motivoCambio: motivoCambio
    };

    if (!payload.confirmar) return { ok: false, requiereConfirmacion: true, resumen: resumen };
    // El resumen que el Jefe aprobo tiene que seguir siendo cierto: si entre la
    // vista previa y la confirmacion cambio otra fila del mismo supervisor, el
    // saldo o la liquidacion "despues" dan otra cosa. No se guarda en silencio.
    const difiere = function (visto, real) {
      return visto !== undefined && visto !== null && Math.abs(Number(visto) - Number(real)) > 1e-9;
    };
    if (difiere(payload.saldoVisto, saldoDespues) || difiere(payload.liqVisto, liqDespues)) {
      return { ok: false, requiereConfirmacion: true, resumen: resumen, cambioResumen: true };
    }
    if (descubierto && !payload.aceptarDescubierto) {
      return { ok: false, requiereConfirmacion: true, resumen: resumen };
    }

    // ---- Escribir (celda por celda, solo lo que cambio) ----
    _verificarFila(ref);
    Object.keys(datos.celdas).forEach(function (col) { _setCelda(ref, col, datos.celdas[col]); });
    if (estadoCambio) {
      _setCelda(ref, 'Estado', nuevoEstado);
      // "Aprobado por" / "Fecha aprobacion" son la ULTIMA decision: con una
      // decision se escribe el Jefe y la hora; al volver a Pendiente se vacian.
      if (nuevoEstado === 'Pendiente') {
        _setCelda(ref, 'Aprobado por', '');
        _setCelda(ref, 'Fecha aprobacion', '');
      } else {
        _setCelda(ref, 'Aprobado por', yo.email);
        _setCelda(ref, 'Fecha aprobacion', new Date());
      }
    }
    // El token se regenera en TODA modificacion: cualquier link de un mail
    // anterior muere y no puede pisar la decision nueva.
    const nuevoToken = Utilities.getUuid();
    _setCelda(ref, 'Token', nuevoToken);

    // ---- Auditoria ----
    let accion;
    if (estadoCambio && nuevoEstado === 'Anulada') accion = 'ANULADA';
    else if (estadoCambio && v.estado === 'Anulada') accion = 'DESANULADA';
    else if (estadoCambio && nuevoEstado === 'Pendiente') accion = 'VUELTA_A_PENDIENTE';
    else if (estadoCambio) accion = 'CAMBIO_DECISION';
    else accion = 'CORRECCION_DATOS';
    _log(ref.id, accion, yo.email, _textoCambios(cambios) +
         ' | Motivo: ' + motivoCambio.replace(/\s*[\r\n]+\s*/g, ' ') +
         ' | Saldo compensable: ' + _fmtHoras(saldoAntes) + ' -> ' + _fmtHoras(saldoDespues));
    if (descubierto) {
      _log(ref.id, 'EDITADA_SALDO_NEGATIVO', yo.email,
           'Saldo compensable queda en ' + _fmtHoras(saldoDespues) + ' hs, confirmado por el Jefe.');
    }

    // ---- Mails (despues de escribir, cada uno en su try/catch) ----
    let mailEnviado = false;
    const avisos = [];
    if (!v.email || _esEmailPlaceholder(v.email)) {
      avisos.push('El cambio se guardo, pero el supervisor no tiene un correo real cargado: no se le mando el mail.');
    } else {
      try {
        _mailModificacion({
          to: v.email, cc: pers, id: ref.id, mov: resumen.mov, email: v.email, supervisor: nombre,
          fechaTexto: _fmtFecha(datos.fecha), estadoFinal: nuevoEstado, cambios: cambios,
          motivoCambio: motivoCambio, mesAnterior: mesAnterior, esAnulacion: nuevoEstado === 'Anulada',
          fechaRaw: datos.fecha
        });
        mailEnviado = true;
      } catch (err) {
        _log(ref.id, 'ERROR_MAIL', yo.email, 'No se pudo avisar la modificacion: ' + err.message);
        avisos.push('El cambio se guardo, pero no se pudo mandar el mail al supervisor. Quedo registrado en Auditoria.');
      }
    }

    let reenvioAprobacion = false;
    if (nuevoEstado === 'Pendiente') {
      try {
        const nota = '<div style="font-family:Arial,sans-serif;max-width:520px;background:#FFF4D6;' +
          'border:1px solid #F8C040;border-radius:4px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#333">' +
          '<b>' + (estadoCambio ? 'Esta solicitud volvio a Pendiente.' : 'Esta solicitud se corrigio.') + '</b> ' +
          'Los links de los mails anteriores ya no sirven: usa los botones de este mail.<br>' +
          cambios.map(function (c) {
            return _escHtml(c.campo) + ': <s>' + _escHtml(c.antes) + '</s> &rarr; ' + _escHtml(c.despues);
          }).join('<br>') +
          '<br>Motivo: ' + _escHtml(motivoCambio) + '</div>';
        const o = {
          to: jefeEmail(), id: ref.id, token: nuevoToken, supervisor: nombre, email: v.email,
          fecha: datos.fecha, horas: datos.horas,
          prefijoAsunto: estadoCambio ? '[VUELVE A PENDIENTE] ' : '[CORREGIDA] ', notaHtml: nota,
          usuarioLog: yo.email
        };
        if (ref.esComp) o.tipo = datos.tipo; else { o.linea = datos.linea; o.motivo = datos.motivo; }
        reenvioAprobacion = ref.esComp ? _enviarMailPendienteCP(o) : _enviarMailPendienteHE(o);
      } catch (err) {
        _log(ref.id, 'ERROR_MAIL', yo.email, 'No se pudo reenviar la aprobacion: ' + err.message);
        reenvioAprobacion = false;
      }
      if (!reenvioAprobacion) {
        avisos.push('No se pudo reenviar el mail de aprobacion: la solicitud esta en Pendiente igual, apruebala desde la app.');
      }
    }

    return {
      ok: true, id: ref.id, estado: nuevoEstado, mailEnviado: mailEnviado,
      avisoMail: avisos.join(' '), reenvioAprobacion: reenvioAprobacion
    };
  });
}

/**
 * Mail al supervisor cuando el Jefe modifica o anula una solicitud o un
 * canje. TODO valor que escribio una persona pasa por _escHtml. Lanza si
 * MailApp falla: lo atrapa quien llama.
 *
 * @param {{to:string, cc:string, id:string, mov:string, email:string, supervisor:string,
 *          fechaTexto:string, estadoFinal:string, cambios:Array, motivoCambio:string,
 *          mesAnterior:(string|null), esAnulacion:boolean}} o
 */
/**
 * Cuando una edicion deja una hora extra Aprobada, el mail dice si se paga o
 * suma al saldo, igual que el mail comun de aprobacion (_notificarResultado).
 * Sin esto, aprobar desde el panel perdia ese dato.
 */
function _parrafoCircuitoAprobada(o) {
  if (o.mov === 'CP' || o.estadoFinal !== 'Aprobada' || !o.fechaRaw) return '';
  try {
    const c = circuitoHE(o.fechaRaw);
    if (c.circuito === 'LIQ') {
      return '<p>Corresponde a ' + _escHtml(_tipoDiaTextoLower(c.tipo)) +
        ': entra en <b>liquidacion</b> (se paga). No suma al saldo de compensacion.</p>';
    }
    return '<p>Suma al saldo de compensacion.</p>';
  } catch (err) {
    return '';
  }
}

function _mailModificacion(o) {
  const esComp = o.mov === 'CP';
  const asunto = (esComp
    ? '[Canje · ' + (o.esAnulacion ? 'Anulado' : 'Modificado')
    : '[Horas Extra · ' + (o.esAnulacion ? 'Anulada' : 'Modificada')) + '] ' + o.fechaTexto;

  const celda = 'padding:6px 12px 6px 0;vertical-align:top';
  let filas = '';
  o.cambios.forEach(function (c) {
    filas += '<tr><td style="' + celda + ';color:#666">' + _escHtml(c.campo) + '</td>' +
             '<td style="' + celda + ';color:#666"><s>' + _escHtml(c.antes) + '</s></td>' +
             '<td style="padding:6px 0;vertical-align:top"><b>' + _escHtml(c.despues) + '</b></td></tr>';
  });

  const cuerpo =
    '<p>Hola ' + _escHtml(o.supervisor) + ',</p>' +
    '<p>El Jefe modifico tu solicitud del <b>' + _escHtml(o.fechaTexto) + '</b> (' + _escHtml(o.id) + ').</p>' +
    '<table style="font-size:14px;border-collapse:collapse">' +
    '<tr><th align="left" style="' + celda + ';font-size:11px;color:#999">Campo</th>' +
    '<th align="left" style="' + celda + ';font-size:11px;color:#999">Antes</th>' +
    '<th align="left" style="padding:6px 0;font-size:11px;color:#999">Despues</th></tr>' +
    filas + '</table>' +
    '<p>Estado actual: <b>' + _escHtml(o.estadoFinal) + '</b>.' +
    (o.esAnulacion ? ' Queda sin efecto: no suma a tu saldo ni a la liquidacion.' : '') + '</p>' +
    '<p>Motivo: ' + _escHtml(o.motivoCambio) + '</p>' +
    _parrafoCircuitoAprobada(o) +
    (o.mesAnterior
      ? '<p style="background:#B00020;color:#fff;font-weight:bold;padding:10px 14px;border-radius:4px">' +
        'Afecta ' + _escHtml(o.mesAnterior) + ', que puede estar ya liquidado.</p>'
      : '') +
    '<p>' + _lineaSaldoMail(o.email, esComp) + '</p>' +
    '<p style="font-size:11px;color:#777">' + CONFIG.NOMBRE_PLANTA + '</p>';

  const opciones = { to: o.to, subject: asunto, htmlBody: cuerpo };
  if (o.cc) opciones.cc = o.cc;
  MailApp.sendEmail(opciones);
}

/**
 * Ultimos cambios para Administracion > Solicitudes y canjes: la actividad de
 * Auditoria (solo ACCIONES_ACTIVIDAD), mas nueva primero, maximo 40. SOLO
 * Jefe. Sin lock. `ref` sale de UNA lectura de Solicitudes y UNA de
 * Compensaciones; para las acciones sobre personas el id es un correo y ref es
 * null. Nunca devuelve el token.
 */
function apiAdminActividad() {
  const yo = _identificar(['Jefe']);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const nombres = _mapaNombres();

  const mapaRef = {};
  [[SH.SOL, 'HE'], [SH.COMP, 'CP']].forEach(function (par) {
    const d = ss.getSheetByName(par[0]).getDataRange().getValues();
    if (d.length < 2) return;
    const enc = d[0];
    const esComp = par[1] === 'CP';
    const cId = _idx(enc, 'ID'), cSup = _idx(enc, 'Supervisor'), cEmail = _idx(enc, 'Email'),
          cFecha = _idx(enc, esComp ? 'Fecha solicitada' : 'Fecha HE'),
          cHoras = _idx(enc, esComp ? 'Horas a compensar' : 'Horas'), cEstado = _idx(enc, 'Estado');
    for (let i = 1; i < d.length; i++) {
      const email = _normEmail(d[i][cEmail]);
      mapaRef[String(d[i][cId])] = {
        mov: par[1], email: email,
        supervisor: nombres[email] || String(d[i][cSup] || '').trim() || 'Sin nombre',
        fechaTexto: _fmtFecha(d[i][cFecha]), horas: parseFloat(d[i][cHoras]) || 0,
        estado: String(d[i][cEstado] || '')
      };
    }
  });

  const items = [];
  const sh = ss.getSheetByName(SH.LOG);
  const d = sh ? sh.getDataRange().getValues() : [];
  if (d.length >= 2) {
    const enc = d[0];
    const cTs = _idx(enc, 'Timestamp'), cId = _idx(enc, 'ID'), cAcc = _idx(enc, 'Accion'),
          cUsu = _idx(enc, 'Usuario'), cDet = _idx(enc, 'Detalle');
    for (let i = d.length - 1; i >= 1 && items.length < 40; i--) {
      const acc = String(d[i][cAcc]);
      if (ACCIONES_ACTIVIDAD.indexOf(acc) === -1) continue;
      const id = String(d[i][cId]);
      const r = mapaRef[id] || null;
      const usu = String(d[i][cUsu] || '');
      items.push({
        ts: _fmtFechaHora(d[i][cTs]),
        id: id,
        accion: acc,
        accionTexto: ACCION_TEXTO[acc] || acc,
        usuario: nombres[_normEmail(usu)] || usu,
        detalle: String(d[i][cDet] || ''),
        ref: r ? { mov: r.mov, supervisor: r.supervisor, fechaTexto: r.fechaTexto, horas: r.horas, estado: r.estado } : null,
        editable: !!r && _puedeAdministrar(yo, { Email: r.email, Estado: r.estado }) && r.estado !== 'Retirada'
      });
    }
  }
  return { items: items };
}

// ==================== MAIL DE CANJE ====================
/**
 * Horas liquidables (sabado/domingo/feriado con vigencia aplicada) de un mes,
 * por Fecha HE, agrupadas por supervisor. La clasificacion es la de
 * circuitoHE(): no se reimplementa aca (misma regla que _desgloseHE y
 * resumenMensual). Lee la hoja Solicitudes UNA vez.
 *
 * @param {number} anio
 * @param {number} mes 1-12
 * @returns {{porEmail:Object, total:{sabDom:number,feriado:number,total:number},
 *            pendientesHE:{cant:number,horas:number}, sinFecha:number}}
 */
function _liquidacionMes(anio, mes) {
  const out = {
    porEmail: {},
    total: { sabDom: 0, feriado: 0, total: 0 },
    pendientesHE: { cant: 0, horas: 0 },
    // Pendientes que, si se aprueban, se liquidan (sab/dom/feriado). Sirve para
    // aclarar que el total "a liquidar" es parcial mientras haya cosas por aprobar.
    pendientesLiq: { cant: 0, horas: 0 },
    sinFecha: 0
  };
  const d = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH.SOL).getDataRange().getValues();
  if (d.length < 2) return out;

  const enc = d[0];
  const cSup = _idx(enc, 'Supervisor'), cEmail = _idx(enc, 'Email'), cHoras = _idx(enc, 'Horas'),
        cEstado = _idx(enc, 'Estado'), cFecha = _idx(enc, 'Fecha HE');
  const nombres = _mapaNombres();

  for (let i = 1; i < d.length; i++) {
    const estado = d[i][cEstado];
    if (estado !== 'Aprobada' && estado !== 'Pendiente') continue;
    const horas = parseFloat(d[i][cHoras]) || 0;
    const partes = _partesFecha(d[i][cFecha]);

    if (estado === 'Pendiente') {
      if (partes && partes.anio === anio && partes.mes === mes) {
        out.pendientesHE.cant++;
        out.pendientesHE.horas += horas;
        if (circuitoHE(d[i][cFecha]).circuito === 'LIQ') {
          out.pendientesLiq.cant++;
          out.pendientesLiq.horas += horas;
        }
      }
      continue;
    }

    if (!partes) { out.sinFecha++; continue; }
    if (partes.anio !== anio || partes.mes !== mes) continue;
    const c = circuitoHE(d[i][cFecha]);
    if (c.circuito !== 'LIQ') continue;

    const email = _normEmail(d[i][cEmail]);
    if (!out.porEmail[email]) {
      out.porEmail[email] = { nombre: nombres[email] || String(d[i][cSup] || '').trim() || 'Sin nombre',
                              sabDom: 0, feriado: 0, total: 0 };
    }
    const f = out.porEmail[email];
    if (c.tipo === 'Feriado') { f.feriado += horas; out.total.feriado += horas; }
    else { f.sabDom += horas; out.total.sabDom += horas; }
    f.total += horas;
    out.total.total += horas;
  }
  return out;
}

const _MESES_MIN = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
                    'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * Datos para armar (en el cliente) el mail de un canje aprobado. SOLO Jefe:
 * es el unico endpoint por el que viajan los correos del equipo. Nunca
 * devuelve token. Las cuentas con hora/saldo salen de tablaSaldos() y
 * _liquidacionMes(); el cliente no calcula plata.
 *
 * @param {string} idOrigen ID del canje (CP-...) desde el que se abre.
 */
function apiMailCanje(idOrigen) {
  const yo = _identificar(['Jefe']);

  const id = String(idOrigen || '').trim();
  if (id.indexOf('CP-') !== 0) throw new Error('Solo se arma el mail de un canje (ID CP-...).');

  const canjes = _leerCanjes();
  const origen = canjes.filter(function (c) { return c.id === id; })[0];
  if (!origen) throw new Error('No se encontro el canje ' + id + '.');
  if (origen.estado !== 'Aprobada') {
    throw new Error('Solo se arma el mail de un canje aprobado (estado: ' + origen.estado + ').');
  }
  const origenClave = _clavePartes(origen.partes);
  if (!origenClave) throw new Error('El canje ' + id + ' no tiene una fecha legible.');

  const hoy = _hoyPartes();
  const minNum = Math.min(_numPartes(hoy), _numPartes(origen.partes));
  const lista = canjes
    .filter(function (c) {
      return c.email === origen.email && c.estado === 'Aprobada' && c.partes &&
             _numPartes(c.partes) >= minNum;
    })
    .map(function (c) {
      return { id: c.id, fechaClave: _clavePartes(c.partes), horas: c.horas,
               tipoCanje: c.tipo, origen: c.id === origen.id };
    })
    .sort(function (a, b) {
      if (a.fechaClave !== b.fechaClave) return a.fechaClave < b.fechaClave ? -1 : 1;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

  // Una sola llamada a tablaSaldos() para el saldo del dueño y el del resto.
  const saldos = tablaSaldos();
  const miSaldo = saldos[origen.email];
  const saldoDe = function (email) {
    const s = saldos[email];
    return s ? s.generadas - s.compensadas : 0;
  };

  const directorio = _directorio();
  const supervisores = directorio.filter(function (p) { return p.rol === 'Supervisor'; });
  const resto = supervisores
    .filter(function (p) { return p.email !== origen.email; })
    .map(function (p) { return { nombre: p.nombre, saldo: saldoDe(p.email) }; })
    .sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });

  const liq = _liquidacionMes(hoy.anio, hoy.mes);
  const liqFilas = Object.keys(liq.porEmail)
    .map(function (e) { return { nombre: liq.porEmail[e].nombre, horas: liq.porEmail[e].total }; })
    .filter(function (f) { return f.horas > 0; })
    .sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });

  const sinPlaceholder = function (p) { return !_esEmailPlaceholder(p.email); };

  return {
    origen: { id: origen.id, fechaClave: origenClave },
    supervisor: { nombre: _mapaNombres()[origen.email] || origen.supervisor },
    hoyClave: _clavePartes(hoy),
    canjes: lista,
    saldoActual: miSaldo ? miSaldo.generadas - miSaldo.compensadas : 0,
    resto: resto,
    liqMes: { anio: hoy.anio, mes: hoy.mes, mesNombre: _MESES_MIN[hoy.mes - 1],
              filas: liqFilas, total: liq.total.total,
              // El total es parcial: lo aprobado hasta hoy. El mail lo aclara para
              // que Personas no lo tome como cierre del mes.
              alDia: Utilities.formatDate(new Date(), CONFIG.TZ, 'dd/MM'),
              pendientesHoras: liq.pendientesLiq.horas },
    horasPorDia: CONFIG.HORAS_POR_DIA,
    feriados: Object.keys(_feriadosMap()),
    para: directorio.filter(function (p) { return p.rol === 'Personas'; })
                    .filter(sinPlaceholder).map(function (p) { return p.email; }),
    cc: supervisores.filter(sinPlaceholder).map(function (p) { return p.email; }),
    yoEmail: yo.email,
    firma: { nombre: yo.nombre, cargo: CONFIG.FIRMA_CARGO }
  };
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

/** {anio,mes,dia} -> "yyyy-MM-dd", o null si no hay partes. */
function _clavePartes(p) {
  if (!p) return null;
  return p.anio + '-' + _pad2(p.mes) + '-' + _pad2(p.dia);
}

/** {anio,mes,dia} -> entero comparable anio*10000+mes*100+dia (null -> 0). */
function _numPartes(p) {
  if (!p) return 0;
  return p.anio * 10000 + p.mes * 100 + p.dia;
}

/** Milisegundos UTC (medianoche) -> {anio,mes,dia}. Solo aritmetica UTC. */
function _partesDeUTC(ms) {
  const d = new Date(ms);
  return { anio: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

/** "Hoy" como {anio,mes,dia} en CONFIG.TZ (no en la zona del servidor). */
function _hoyPartes() {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd'));
  return { anio: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]) };
}

/**
 * Mapa {emailNormalizado: nombre} del directorio, armado UNA vez. Usar esto
 * dentro de un bucle: nombreDe() relee el directorio en cada llamada.
 */
function _mapaNombres() {
  const mapa = {};
  _directorio().forEach(function (p) { mapa[p.email] = p.nombre; });
  return mapa;
}

/** Iniciales de un nombre: primera letra de cada palabra, mayuscula, maximo 3. */
function _iniciales(nombre) {
  return String(nombre || '').trim().split(/\s+/).filter(Boolean)
    .map(function (w) { return w.charAt(0).toUpperCase(); })
    // Maximo 2 letras: la marca del dia mide ~39px utiles a 390px de ancho, y
    // con dos personas de nombre largo ("ABC? DEF?") la segunda se recortaba
    // y se perdia el "?" de pendiente. Con 2 letras "AB? CD?" entra.
    .slice(0, 2).join('');
}

/**
 * Lector UNICO de la hoja Compensaciones (canjes), una sola lectura.
 * Sin filtro de rol ni de estado: quien la use filtra segun su caso.
 * @returns {Array<{id:string, supervisor:string, email:string,
 *   partes:({anio:number,mes:number,dia:number}|null), fechaTexto:string,
 *   horas:number, tipo:string, estado:string, comentario:string}>}
 */
function _leerCanjes() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH.COMP);
  if (!sh) return [];
  const d = sh.getDataRange().getValues();
  if (d.length < 2) return [];
  const enc = d[0];
  const cId = _idx(enc, 'ID'), cSup = _idx(enc, 'Supervisor'), cEmail = _idx(enc, 'Email'),
        cFecha = _idx(enc, 'Fecha solicitada'), cHoras = _idx(enc, 'Horas a compensar'),
        cTipo = _idx(enc, 'Tipo'), cEstado = _idx(enc, 'Estado'), cCom = _idx(enc, 'Comentario');
  const nombres = _mapaNombres();
  const out = [];
  for (let i = 1; i < d.length; i++) {
    if (!d[i][cId]) continue;
    const email = _normEmail(d[i][cEmail]);
    out.push({
      id: String(d[i][cId]),
      // Sin nombre en la hoja ni en el directorio (alguien dado de baja): mejor
      // un rotulo explicito que una fila vacia en el mail y el calendario.
      supervisor: String(d[i][cSup] || '').trim() || nombres[email] || 'Sin nombre',
      email: email,
      partes: _partesFecha(d[i][cFecha]),
      fechaTexto: _fmtFecha(d[i][cFecha]),
      horas: parseFloat(d[i][cHoras]) || 0,
      tipo: String(d[i][cTipo] || ''),
      estado: String(d[i][cEstado] || ''),
      comentario: String(d[i][cCom] || '')
    });
  }
  return out;
}

function _mailAprobacion(o) {
  const url = a => CONFIG.WEBAPP_URL + '?id=' + o.id + '&token=' + o.token + '&accion=' + a;
  let filas = '';
  o.filas.forEach(f => {
    // Los valores los escriben personas (motivo, linea, nombre del feriado):
    // sin escapar, un "<" rompe el render del mail y una etiqueta completa
    // inyecta HTML en la casilla del Jefe.
    filas += '<tr><td style="padding:6px 12px 6px 0;color:#666">' + _escHtml(f[0]) +
             '</td><td style="padding:6px 0"><b>' + _escHtml(f[1]) + '</b></td></tr>';
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
    .appendRow([new Date(), id, accion, usuario, _celdaSegura(detalle)]);
}

// ==================== WEBAPP PROPIA (futuro) ====================
/**
 * Incluye un archivo .html dentro de otro (partials de la WebApp propia
 * que reemplaza a AppSheet). Uso: <?!= include('nombre-del-archivo'); ?>
 */
function include(nombre) {
  return HtmlService.createHtmlOutputFromFile(nombre).getContent();
}
