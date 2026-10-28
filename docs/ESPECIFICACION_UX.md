# Juanca — especificación de experiencia de usuario

**Estado de referencia:** 24 de octubre de 2026. PostgreSQL es la autoridad activa. Esta especificación describe la interfaz productiva y marca como **objetivo** las funciones aún no implementadas. Ver [reglas funcionales](ESPECIFICACION_FUNCIONAL.md) y [arquitectura técnica](ESPECIFICACION_TECNICA.md).

## 1. Principios de interfaz

- El usuario siempre puede distinguir **dato observado**, **dato corregido**, **estimación** y **pendiente de revisión**.
- Titular, custodio, cuenta, emisor y fuente aparecen con nombres distintos. B3 se presenta como fuente del reporte, nunca como cuenta o custodio.
- Un cálculo parcial indica cobertura y razón. Cero, ausencia de precio y falta de permisos son estados distintos.
- Consultar no modifica la cartera. Una operación requiere revisar los campos y aprobar una propuesta concreta.
- La interfaz funciona en escritorio y móvil; la PWA no guarda datos patrimoniales para lectura offline ni reenvía escrituras automáticamente.

## 2. Navegación vigente

| Pestaña | Necesidad principal | Contenido |
|---|---|---|
| Visão geral | Saber cuánto y de quién | Total, subtotales, distribución, actividad, calidad y acceso a posiciones |
| Revisões | Resolver incertidumbre | Movimientos ambiguos, candidatos B3, fotos, decisiones con evidencia y conciliación de compras contra snapshot B3 |
| Juanca | Consultar en lenguaje natural | Conversación guiada propia; el puente Hermes es una opción heredada |
| Assistente | Registrar una operación comunicada | Texto/comprobante, interpretación, propuesta y aprobación/rechazo |
| Importar | Actualizar fuentes | B3, Avenue y previsión; archivo, titular, fecha y estado |
| Renda fixa | Ver vencimientos y crecimiento estimado | Matriz temporal por titular, emisor y título |
| Projeções | Explorar un escenario | Simulación nominal/real con supuestos editables |
| Recomendações | Identificar próximos análisis | Tarjetas informativas; aclarar cuando una regla aún no calcula con la cartera real |

En escritorio la navegación lateral deja espacio al contenido. En móvil se convierte en pestañas desplazables; formularios y tablas deben conservar controles táctiles, tipografía legible y desplazamiento horizontal propio cuando hay muchas columnas. El acceso privado conserva login, sesión recordada opcional y salida explícita.

## 3. Renta fija: matriz de tiempo

La vista inicia con cuatro indicadores: valor actual cubierto, estimación en los vencimientos, crecimiento estimado y cobertura del modelo. Debajo se muestra el filtro **Investidor** con `Todos` y los titulares que aparecen en los datos actuales. `Todos` puede mostrar a varios titulares, pero nunca une sus títulos bajo una cuenta común.

| Elemento | Interacción y significado |
|---|---|
| Encabezado de año | Se ve como columna compacta; el botón `+` lo expande a meses y `−` lo colapsa. Se pueden expandir varios años. |
| Meses | Columnas en orden cronológico hasta el último vencimiento disponible. El último período puede terminar en la fecha exacta de vencimiento. |
| Fila de emisor | Agrupa títulos del mismo titular y emisor. Su botón expande o colapsa títulos; se muestra titular y cantidad de títulos. |
| Fila de título | Muestra código, nombre y vencimiento; cada celda usa la misma regla de cálculo que la fila agregada. |
| Importe principal | Saldo proyectado de los títulos que siguen vigentes al final del período. |
| `Venc.` | Importe proyectado al vencimiento de títulos que vencen dentro del período, separado del saldo activo. |
| Guion `—` | No hay importe para esa celda; la ausencia de proyección por datos insuficientes se explica mediante cobertura y metodología. |

La primera columna permanece visible mientras el usuario se desplaza horizontalmente; las cabeceras permanecen visibles al desplazarse verticalmente. La tabla conserva encabezados y botones con `aria-expanded` para teclado y lector de pantalla. Al cambiar de inversor se cierran las filas de emisor previamente abiertas para evitar que un estado visual antiguo se aplique a otro conjunto.

La nota metodológica bajo la matriz explica que se extrapola una tasa **histórica observada**, que cada título se detiene al vencimiento y que no se incluyen impuestos, cupones ni amortizaciones. No mostrar un importe de proyección cuando faltan fechas, precios o tasa utilizable. **Objetivo:** ofrecer en el futuro una vista contractual diferenciada, con indexador, cupones y supuestos propios.

## 4. Consulta, carga y revisión

### Estado de preparación PostgreSQL

La pestaña **Cartera y movimientos** muestra la cartera activa y el estado de autoridad. La comparación previa al corte se conserva como evidencia privada y no se presenta como comparación en vivo. El estado técnico no sustituye una aprobación de movimiento; las decisiones siguen ocurriendo en Revisões/Assistente con auditoría.

### Cartera y calidad

La vista general muestra fecha de referencia y cobertura junto a importes. En la cartera, un filtro por titular y una búsqueda por activo ayudan a localizar posiciones; cantidad, moneda, precio, costo y variación solo se muestran cuando existe dato suficiente. Si faltan PTAX, cuenta o evidencia, el motivo debe acompañar el subtotal o posición afectada. Un resumen de revisiones permite abrir el caso concreto.

### Conciliación de adquisiciones

En **Revisões**, la conciliación PostgreSQL compara la cantidad del snapshot B3 con compras brutas registradas por posición, junto con titular, institución, cuenta y fecha de corte. El filtro de titular limita las filas; por defecto se muestran posiciones que ya tienen lotes registrados y un control permite incluir las demás. Los indicadores resumen el universo completo, aunque algunas filas estén ocultas por el filtro. El estado y la diferencia se leen como diagnóstico: las compras brutas no descuentan ventas, rescates ni transferencias, y una diferencia no determina el saldo de apertura ni el costo vigente. Si hay adquisiciones posteriores al snapshot, no se presenta una diferencia comparable. El diagnóstico es de solo lectura y ofrece actualización manual.

### Importación

El formulario pide fuente, titular, tipo de archivo y fecha de referencia cuando corresponda. Debe confirmar recepción, progreso, procesamiento o fallo con una explicación accionable. Un documento repetido devuelve el resultado ya conocido; no crea otra posición. En B3 se ve el corte del snapshot y la cobertura temporal de movimientos. Para publicar snapshots en Revisões, cada tarjeta identifica titular, fuente y fecha real del extracto. Si esa fecha es anterior al corte global, la confirmación informa que la cartera se reconstruirá al corte actual y conservará la fecha fuente en las posiciones. Solo el documento más reciente del titular/fuente ofrece la acción de revisión; un documento sustituido explica que requiere corrección histórica. La acción sigue siendo individual y requiere confirmación explícita. La bandeja de Revisões presenta diferencias candidatas entre reportes; su decisión actualiza la cartera solo cuando se confirma una publicación aprobada. **Objetivo:** enlazar cada cambio publicado con las filas antiguas y nuevas que lo justifican.

### Foto o mensaje de movimiento

La recepción se confirma aunque la extracción no haya terminado. Se puede abrir el original, leer el texto reconocido y ver campos interpretados con su nivel de certeza. Titular, institución/cuenta, instrumento, fecha, cantidad, precio y moneda faltantes se muestran como pendientes. Un vínculo sugerido con B3 se etiqueta como candidato hasta que una persona lo confirme o descarte. Confirmar correspondencia no equivale a aplicar una operación.

### Propuesta transaccional

La propuesta presenta un resumen antes de habilitar `Aprovar` o `Rejeitar`. El usuario ve los datos económicos, la cuenta y la evidencia utilizada; un campo no confirmado se señala de forma específica. Tras decidir se muestra estado final e identificador estable. Reintentar una aprobación por latencia debe mostrar el mismo resultado, sin crear una segunda operación. Si la identidad de custodia o la cantidad de la posición invertida es insuficiente, se explica el bloqueo. La aprobación no pide ni consulta saldo de caja; ese control queda en manos del usuario.

### Registro de movimientos

La pestaña separada de movimientos pide inversor, cuenta identificada y evidencia escrita o foto pendiente del mismo titular antes de guardar ticker, lado, moneda, cantidad, precio, comisiones y fecha. La evidencia se enlaza una sola vez y aparece en la cola de propuestas junto con el movimiento. Las cuentas no resueltas aparecen deshabilitadas. El resultado queda en «Pendiente de aprobación» hasta que una persona con rol `owner` o `approver` decida. La aprobación publica un evento versionado en PostgreSQL y actualiza la cartera; el historial y la evidencia permanecen auditados. Si el servicio no está disponible, se conserva el formulario y se explica que el resultado no se confirmó.

## 5. Estados transversales

| Estado | Respuesta de la interfaz |
|---|---|
| Cargando | Indicar qué se está cargando; conservar contexto y evitar doble envío. |
| Vacío | Explicar qué dato falta y qué acción puede incorporarlo. No traducir vacío como patrimonio cero. |
| Parcial | Mostrar importe disponible, cobertura, fecha y causa de lo no valorado. |
| Pendiente de revisión | Identificar evidencia, incertidumbre y decisión disponible. |
| Error temporal | Mantener la entrada del usuario, permitir reintento seguro y no afirmar que una escritura fracasó si el resultado es incierto. |
| Sin conexión | Mostrar pantalla de desconexión y reintentar navegación solo por iniciativa del usuario; no almacenar ni reenviar una mutación. |
| Sin autorización | Volver al login o mostrar 401; al cerrar sesión se revoca el dispositivo actual. |

## 6. Criterios de aceptación UX

1. Jorge y Julia pueden consultar sus vistas por separado sin atribución cruzada; `Todos` conserva el titular visible en cada grupo.
2. En renta fija, el año se expande a meses y el emisor a títulos con mouse, toque y teclado; el saldo de una fila agrupada coincide con la suma de sus títulos.
3. El período de vencimiento informa el flujo por `Venc.`; períodos posteriores no mantienen el título como saldo activo.
4. Una tabla ancha se desplaza horizontalmente en móvil sin perder la columna identificadora ni impedir la navegación del resto de la página.
5. Una carga o corrección nunca desaparece de la bandeja por fallar OCR, parser o identificación de cuenta; se ve su estado y original.
6. Ninguna pantalla transforma un dato incompleto en un total completo o una estimación contractual.
7. Las acciones de aprobación/rechazo tienen foco, nombre accesible, confirmación visible y resultado idempotente.
8. La conciliación de adquisiciones distingue las posiciones sin lotes, las compras posteriores al corte y las cantidades iguales o diferentes; ningún estado sugiere que las compras brutas equivalen automáticamente al saldo actual.

## 7. Interacciones P0: implementación y aceptación

La matriz productiva expande años y emisores y muestra referencia por título, corte por columna, totales parciales y los estados «Sem cobertura», «Faltam dados», «Em revisão» y «Vencido». El control «Motivo» abre la explicación con un elemento nativo accesible. La pestaña Cartera y movimientos identifica la autoridad activa; el delta D1/R2–PostgreSQL queda en evidencia privada. Los requisitos siguientes mantienen el alcance integral de aceptación.

| Requisito | Presentación requerida |
|---|---|
| P0-01 | En renta fija, mostrar título, custodio y cuenta declarada; indicar cuando falta cuenta. Las adquisiciones separadas por cuenta siguen pendientes |
| P0-02 | En carga/revisión, explicar si el resultado actualiza la cartera o registra evidencia pendiente; evitar términos internos como D1 o PostgreSQL en la tarea del usuario |
| P0-03 | Detalle muestra tasa histórica, intervalo, cantidad de observaciones, confianza y fuentes usadas, incluida la compra B3 cuando su identidad y cantidad se confirman; advierte mezcla MTM/curva. En Revisões, una conciliación de solo lectura contrasta las compras brutas registradas con el snapshot B3 y explica sus límites. Un costo con fuente de hoja no verificada aparece como excluido, conserva su referencia de celda y no alimenta la tasa hasta confirmar el mapeo. Fechas de emisión/compra/liquidación y conflictos de adquisición siguen pendientes |
| P0-04 | Encabezados distinguen «Saldo al cierre» y «Vencimientos del período»; año parcial indica fecha de corte y flujos no se presentan como reinversión |
| P0-05 | Identificar referencia por posición y total parcial; distinguir «Sin cobertura», «Faltan datos», «En revisión» y «Vencido», con explicación accesible |

Ejemplo sintético de aceptación: un título vence el 31 de marzo. Marzo muestra el importe como vencimiento y saldo cero; abril indica «Vencido». La columna anual incluye ese flujo una sola vez. Otro título con referencia inicial en abril indica «Sin cobertura» para marzo: no convierte esa ausencia en cero ni elimina el vencimiento del primero.

Los totales por emisor incluyen únicamente las posiciones elegibles y marcan las excluidas. El usuario puede abrir la razón de exclusión desde el título; un guion aislado no basta para distinguir dato desconocido de ausencia de saldo. Cambiar de titular o expandir un año conserva la versión de cálculo y no modifica los hechos patrimoniales.

En la edición manual del costo se muestra la institución/cuenta disponible y el historial de ajustes registrados. Cada cambio agrega una entrada con su fecha base, cantidad, precio unitario medio y momento de registro. Si el mismo titular, instrumento y moneda aparece en varias posiciones sin identidad de cuenta suficiente, el costo agregado se marca pendiente y no se ofrece edición hasta resolver esa ambigüedad.

La proyección de renta fija lee la cartera PostgreSQL activa y conserva la matriz mensual/anual, el desglose por emisor y los filtros por titular. La estimación presenta fuente, fecha y cobertura; no representa una promesa contractual ni ejecuta movimientos.

La pestaña Cartera y movimientos muestra conteo, valor invertido y fecha del snapshot desde la autoridad activa; excluye `USD_CASH`, porque la caja queda fuera del alcance patrimonial acordado. El delta D1/R2–PostgreSQL del corte se conserva como evidencia privada y no se presenta como comparación operativa en vivo.

El panel de mercado pide tickers B3 y de Estados Unidos y actualiza solo cuando el usuario pulsa «Actualizar precios». Muestra el estado del trabajo asíncrono, cotización, proveedor y hora observada, además del USD/BRL disponible. No se consulta proveedores automáticamente al abrir la pestaña.

## Bandeja unificada de Revisiones (28/10/2026)

Revisiones presenta una sola lista con tres estados: **Para decidir**, **Faltan datos** e **Historial**. Las propuestas de movimientos, confirmaciones y extractos publicables aparecen primero; textos y fotos sin propuesta quedan en Faltan datos. Cada estado se ordena por fecha de recepción de la evidencia o del caso, de más reciente a más antiguo. La fecha económica se muestra por separado como «Operación/corte». La ficha compacta indica titular, asunto, institución de custodia cuando existe, estado y cantidad de evidencias relacionadas. El botón «Revisar…» abre el detalle y expone la decisión final solo allí.

La foto vinculada por identificador y los textos que coinciden exactamente en titular, tipo, ticker, cantidad y fecha se muestran dentro de la propuesta. La coincidencia textual se etiqueta como sugerencia para comprobar; si varias propuestas comparten esos datos, el texto permanece en Faltan datos. Nunca se fusionan operaciones financieras por similitud. La cuenta se muestra con el nombre de institución obtenido de la posición y, solo si hay más de una cuenta de la misma institución, se añade una referencia corta claramente marcada como interna. La cadena técnica `account_scope` no se presenta como nombre de custodia.

La bandeja admite búsqueda por ticker/asunto e incluye filtros de titular, tipo y custodia. Las respuestas, aprobaciones y publicaciones exigen la acción final explícita; la versión de cartera y de propuesta se verifica al decidir. Las herramientas extensas de conciliación B3 y costos están bajo «Conciliación detallada de B3 y costos». El formulario de movimiento conserva un acceso directo a Revisiones, donde se atienden las propuestas pendientes.
# Revisión de una orden recibida por foto

La tarjeta de la foto muestra un formulario con titular, custodia, tipo de operación, ticker, cantidad, precio unitario, moneda y fecha extraídos del OCR. Todos los valores son editables salvo el titular de la evidencia. La foto original se abre junto al formulario. Si la imagen es de una orden solicitada, el botón de guardar propuesta permanece deshabilitado hasta marcar «Confirmo que la orden fue ejecutada». El usuario debe elegir la custodia y puede corregir errores de lectura antes de guardar la propuesta pendiente. El botón de aprobar aparece solo en la tarjeta de la propuesta resultante.

Una respuesta que inicia trabajo técnico (`keeps_open`) pasa a **En seguimiento** y muestra la decisión ya registrada sin ofrecer nuevamente el botón de responder. Cuando se verifica que el trabajo terminó, el caso pasa a **Historial**, conserva la decisión original y muestra «Seguimiento completado».

La cabecera de Revisiones ofrece un botón visible **Refrescar revisiones**. Al pulsarlo, la bandeja vuelve a consultar propuestas, confirmaciones, evidencias, extractos, cuentas y cartera; se actualizan las tarjetas y los contadores sin recargar toda la página. Mientras consulta, la bandeja indica «Actualizando…».
