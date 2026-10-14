# Reglas de trabajo del proyecto

Sistema de control y aprobación de horas extra (VSPT / Planta Graffigna).
App en producción: un error significa horas mal liquidadas en el sueldo de alguien.
Idioma: español rioplatense en código, comentarios, UI, mails y conversación.
Sin tildes en identificadores de código.

## Cómo se trabaja cada cambio

Definido por el Jefe de Fraccionamiento. Rige para toda sesión futura.

### 1. Primero se pregunta, después se construye

Antes de construir, preguntar al Jefe **detalle a detalle** cómo va a ser el cambio,
con una recomendación propia en cada opción (marcada como "Recomendado" y primera).
Durante el trabajo, volver a consultar **solo** si aparece una decisión de criterio
suya (plata, política de RRHH, quién ve qué). Lo técnico se resuelve sin preguntar.

### 2. Tamaño del cambio

- **Chico** (un texto, un color, un arreglo de pocas líneas sin efecto en números):
  lo hace la sesión principal directamente y lo verifica.
- **Funcionalidad nueva, o todo lo que toque saldos, liquidación, feriados, fechas o
  permisos por rol**: estructura completa, sin excepción.

### 3. Estructura completa

| Paso | Rol | Modelo | Qué hace |
|---|---|---|---|
| 1 | Maqueta | sesión principal | Página interactiva con datos reales o de ejemplo marcados como tales, para que el Jefe vea cómo queda antes de tocar código |
| 2 | Director | `opus` | Lee todo el código y escribe el plan: decisiones, contratos, trampas, casos de prueba |
| 3 | Ejecutor | `sonnet` | Implementa el plan al pie de la letra. No commitea |
| 4 | Revisor | `opus` | Audita el diff, escéptico, con los números verificados ejecutando la lógica |
| 5 | Cierre | sesión principal | Corrige los hallazgos, reverifica, commitea y entrega |

Los roles están definidos en `.claude/agents/` (director, ejecutor, revisor).

**Modelos siempre por alias** (`opus`, `sonnet`, `haiku`, `fable`), nunca con número de
versión: el alias usa automáticamente la versión más nueva de cada familia.

### 4. Si un modelo no está disponible

(sin crédito, caído, rate limit)

- Pasar al siguiente y avisar en el resumen final, sin frenar el trabajo:
  `opus` no disponible → `sonnet`; `sonnet` no disponible → `opus`.
- El revisor nunca es el mismo modelo que el ejecutor. Si solo queda un modelo,
  usarlo igual y decir explícitamente que la revisión **no fue independiente**.
- `fable` no se usa por defecto (tiene cupo propio y se agotó una vez a mitad de un
  trabajo). Solo si el Jefe lo pide para un cambio puntual.

### 5. Qué se entrega al final

1. **Los 4 archivos listos para pegar**: `ControlHorasExtra.gs`, `Index.html`,
   `Estilos.html`, `JsApp.html`. El `.gs` entregado lleva la `WEBAPP_URL` real puesta
   (pedirla al Jefe si no está en la conversación). Esa copia va en el scratchpad,
   **nunca** al repo.
2. **Paso a paso para publicar**: qué pegar, qué función ejecutar, y Implementar →
   Gestionar implementaciones → lápiz → Nueva versión.
3. **Cómo probarlo**: casos concretos con los números que tienen que dar.

## Reglas duras del código

- **Privacidad**: ningún correo real (`@vspt.com.ar`) ni nombre real de empleado en
  ningún archivo del repo: código, comentarios, ejemplos, tests ni mensajes de commit.
  Ejemplos con `@ejemplo.invalid` y "Supervisor A". Grep antes de cada commit.
  La URL de la WebApp tampoco va al repo (contiene el dominio de la empresa).
- **Fechas**: todo día de semana se calcula `_partesFecha()` → `Date.UTC` →
  `getUTCDay()`. Nunca `getDay()` sobre el valor crudo. La zona horaria de la planilla
  debe coincidir con `CONFIG.TZ` (ver `verificarZonaHoraria()`).
- **Una sola fuente de verdad** para reglas de plata: `circuitoHE` / `_desgloseHE` /
  `saldoSupervisor`. No reimplementarlas en otro lado ni en el cliente.
- **Alcance por rol siempre en el servidor**. El token nunca viaja al cliente.
- **Escape**: todo texto escrito por personas pasa por `esc()` en el cliente y
  `_escHtml()` en los mails.
- **Diseño**: solo tokens existentes de `Estilos.html`, contraste AA en claro y oscuro
  (calculado, no asumido), estado nunca solo por color, mobile-first a 390px.
- Apps Script sin build, sin npm, sin librerías externas.
