# Juanca — especificación funcional

**Estado de referencia:** 21 de octubre de 2026. **Alcance:** comportamiento vigente y destino de la transformación. La [especificación técnica](ESPECIFICACION_TECNICA.md) identifica el sistema que escribe los datos; la [especificación UX](ESPECIFICACION_UX.md) define su presentación. Los apartados marcados **objetivo** aún no son una función productiva.

## 1. Propósito y límites

Juanca permite a Jorge y Julia consultar y mantener una visión trazable del patrimonio familiar. Reúne posiciones, movimientos, costos, documentos, precios y vencimientos procedentes de B3, custodios y entradas manuales. Produce valoraciones y escenarios indicativos. No envía órdenes a corredores ni sustituye una liquidación, un extracto de custodia o un cálculo tributario.

La web vigente y su base D1 local son la autoridad de los datos familiares. La aplicación PostgreSQL y los servicios de ingesta y mercado funcionan en **sombra**: reciben evidencia, prueban reconciliaciones y exponen consultas identificadas como no autoritativas. Publicar o decidir en la sombra no altera por sí solo la cartera vigente.

## 2. Actores y conceptos

| Concepto | Regla |
|---|---|
| Actor | Persona o sesión que consulta, carga o confirma. La web actual usa una identidad familiar compartida; esto no demuestra cuál de los titulares tomó una decisión histórica. |
| Titular | Jorge o Julia, dueño económico de la posición. El titular no es la cuenta de acceso web. |
| Custodio | Institución que mantiene la cuenta, como BTG, Itaú, Avenue o el proveedor de previsión. |
| Cuenta | Cuenta del titular en un custodio. Las cuentas de titulares diferentes nunca se fusionan. Una referencia desconocida se conserva como pendiente. |
| B3 | Fuente de reporte agregada de posiciones y movimientos informados por custodios; **no es un custodio**. |
| Emisor | Entidad obligada por un título de renta fija; es distinta del custodio y de B3. |
| Evidencia | Archivo, fila, foto o mensaje original con fecha de recepción, referencia y lectura versionada. |
| Hecho | Movimiento económico o posición aceptada para calcular la cartera. Una coincidencia de evidencia no crea automáticamente otro hecho. |

Jorge confirmó una cuenta de custodia por institución para los reportes B3 recibidos. Esa confirmación no autoriza a asignar arbitrariamente cuentas a Julia ni a mezclar dos instituciones de Itaú. Los activos fuera de B3, como previsión y Avenue, entran mediante sus propias fuentes.

## 3. Recorridos y disponibilidad

### Consulta y valoración

La vista general muestra patrimonio consolidado en BRL, subtotales por titular, clases de activo, actividad y calidad de datos. La cartera permite consultar cantidades, valor, costo y resultado no realizado cuando existe base suficiente. Un tipo de cambio ausente o una identidad incierta debe ser visible; no se inventa un total completo. Las cotizaciones brasileñas, estadounidenses y USD/BRL provienen de procesos o consultas de mercado con fecha y fuente identificables.

La web dispone de simulación nominal/real con parámetros editables. Sus tarjetas de recomendaciones actuales son orientación de interfaz; no deben presentarse como recomendaciones financieras calculadas a partir de toda la cartera.

### Importación y conciliación

El siguiente flujo es el objetivo completo. La importación vigente y la conciliación en sombra son capacidades distintas, según la matriz de estado de la sección 7.

1. El usuario elige titular y fuente, envía el documento y ve su estado.
2. Se conserva el original y se registran hash, fecha, tipo, hoja/fila o página y resultado del parser.
3. El parser extrae afirmaciones. Un archivo idéntico no duplica hechos.
4. El sistema compara por titular, custodio, cuenta, instrumento y tiempo. Una diferencia o identidad incompleta pasa a revisión.
5. La decisión humana queda trazada; la corrección conserva la evidencia anterior.

Los archivos B3 de **posición** son fotografías patrimoniales con fecha de corte. Los de **movimientos** ofrecen historia de entradas, salidas y eventos. El movimiento ya incluido en una fotografía no vuelve a sumarse sobre ella. La conciliación distingue compra/venta, liquidación, transferencia, rendimiento, amortización, rescate y evento corporativo. Dos filas parecidas pueden ser evidencias del mismo hecho, pero esa relación se valida antes de afectar cantidades.

**Estado de conciliación (21/10/2026):** el snapshot B3 de Jorge del 19/10 se comparó con el del 09/10. Aparecen seis diferencias: cuatro posiciones añadidas, una retirada y una cantidad modificada. El archivo de movimientos disponible cubre hasta el 08/10, por lo que no explica ninguna de las diferencias posteriores al corte anterior. Se conservan como candidatos de revisión; no se reconstruyen movimientos ni se publican cambios por inferencia. Para cerrar el intervalo hace falta un extracto de movimientos que cubra el período posterior al 09/10 o evidencia directa equivalente. Para Julia se comparó el snapshot B3 del 19/10 con el snapshot legado del 29/08: 18 instrumentos coinciden por cuenta e instrumento y quedan seis diferencias candidatas, tres entradas y tres salidas. El extracto de movimientos recibido el 21/10 contiene 66 filas entre el 23/04 y el 20/10; 65 quedaron ligadas a cuenta y una retirada de custodia de XP sigue sin cuenta/contraparte. En la ventana del snapshot, tres diferencias de cantidad concuerdan exactamente con aplicaciones y rescates (CDB326C3F18, CDB9266Y62Z y CDB92685F8M). La compra a término de 45 BTGL52 coincide en cantidad, pero permanece como evidencia candidata por su semántica de operación. Para CDB826DDEHV se explican 950.024 de 1.000.000 unidades retiradas; quedan 49.976 sin movimiento coincidente. CDB323TLJXC (70 unidades retiradas) no tiene movimiento coincidente. Dos filas adicionales tienen evento genérico sin interpretar. La cobertura se infiere del rango de fechas de las filas y no certifica por sí sola que el extracto sea exhaustivo; el snapshot legado no tiene assertions B3 archivadas. Todo sigue `candidate_only`: no se aplicaron movimientos ni se publicaron cambios patrimoniales.

Julia confirmó una cuenta por institución. Esa regla ya está aplicada a sus 21 filas históricas del snapshot legado del 29/08 mediante una resolución auditada contra los identificadores canónicos de custodia. El archivo original B3 de ese corte no está registrado como assertion, por lo que la resolución acredita la cuenta según la confirmación del usuario, no una coincidencia de fila B3. La versión sombra marca esas posiciones con identidad conocida y conserva sus cantidades y valores; las 21 filas del snapshot fuente del 19/10 siguen con interpretación `needs_review`.

Avenue aporta extractos de posición y confirmaciones; la previsión aporta saldo del participante según el documento del proveedor. Una foto o un movimiento escrito se guarda desde su recepción aun si OCR, cuenta, fecha o interpretación quedan pendientes. La sombra dispone de carga documental, OCR local para formatos compatibles y bandejas de candidatos; su aplicación al patrimonio autoritativo sigue bajo revisión.

**Alcance de caja:** el sistema registra y valora patrimonio invertido (posiciones y cantidades por titular, institución/cuenta e instrumento). Los saldos bancarios y efectivo en custodia quedan fuera del alcance y bajo control del usuario: no se solicitan extractos para reconstruirlos, no se incluyen en el patrimonio invertido y no se usan como condición para aprobar una compra o venta. La aplicación conserva precio, principal y comisiones de la operación como datos del hecho histórico, pero no deriva ni mantiene un saldo de caja. En compras/ventas se valida la identidad de la cuenta y la cantidad disponible del activo cuando corresponde.

### Movimientos y aprobaciones

El chat transaccional interpreta texto o comprobantes y prepara una propuesta. Antes de aprobar se muestran titular, activo, lado, cantidad, precio, moneda, fecha, cuenta y comisiones disponibles. Campos ausentes o ambiguos requieren completar o revisar. Aprobar o rechazar es una acción explícita; una consulta nunca aprueba. La aprobación debe ser idempotente y no puede aplicar dos veces una misma propuesta. No se ejecutan órdenes de inversión.

El chat guiado propio responde consultas habituales sin Hermes. El chat libre mediante Hermes permanece como integración heredada opcional. **Objetivo:** todos los recorridos patrimoniales habituales funcionan con Hermes detenido; un modelo directo puede ayudar a interpretar lenguaje libre, pero no decide custodia, deduplicación ni aprobaciones.

### Revisiones y costos

Las revisiones muestran evidencia, motivo, titular, cuenta y efecto posible. La web vigente permite decidir registros ambiguos y la sombra conserva decisiones auditadas sobre vínculos y conciliaciones. Vincular una foto o una fila B3 a un mensaje expresa correspondencia de evidencia; no autoriza a contabilizar una operación.

El costo de adquisición puede proceder de una compra documentada, un dato manual o una fuente histórica. Se conservan referencias heredadas a precios y fechas de una hoja de inversión, pero el mapeo de esas columnas no está verificado contra los encabezados vigentes; por eso esas observaciones quedan excluidas de la proyección hasta confirmar su fuente y significado. Las compras identificadas en movimientos B3 son evidencia separada y solo se usan cuando cumplen las reglas de identidad, cobertura y cantidad de la sección de proyección. Todo costo conserva titular y procedencia, sin confundir precio de compra con precio de mercado.

## 4. Renta fija: histórico y proyección

La proyección vigente toma observaciones de precio por titular e instrumento. Una compra B3 puede servir como adquisición inicial solo si se identifica la institución, hay un único día de compra, las filas no requieren revisión, no aparecen ventas ni otros cambios de principal y la cantidad comprada coincide con la posición actual. Compras del mismo día se combinan con promedio ponderado por cantidad; se omiten fechas ya cubiertas por un snapshot y movimientos sin institución identificable. Un costo de otra fuente se usa solo cuando su procedencia está verificada. Los costos referenciados a la hoja con un mapeo de columnas pendiente se excluyen del cálculo hasta su confirmación y permanecen visibles como fuente excluida. Requiere dos fechas con precios positivos y vencimiento válido. Anualiza la variación observada y compone el precio hasta cada período y hasta el vencimiento. La tasa obtenida **no equivale necesariamente a la tasa contractual**. La interfaz muestra la confianza: alta desde 180 días y cuatro observaciones; media desde 90 días y tres; baja para historiales más cortos. No modela completamente CDI/IPCA, cupones, amortizaciones, impuestos, rescate anticipado ni riesgo de crédito; tasas fuera del intervalo admitido se excluyen.

La pantalla presenta una matriz horizontal. Cada año ocupa una columna expandible a meses; cada fila agrupa un emisor y se expande a sus títulos. El filtro separa a Jorge y Julia. En cada celda, el saldo proyectado representa títulos que siguen vigentes al corte; los vencimientos del período se muestran aparte. Un título deja de sumar al saldo después de vencer. Los títulos sin tasa o fecha suficientes permanecen identificables, pero no aportan importes inventados a la serie.

**Objetivo:** incorporar condiciones contractuales e indexadores por título antes de utilizar proyecciones para decisiones de inversión. Conservar en paralelo la estimación basada en histórico, etiquetada con su método y cobertura.

## 5. Reglas de integridad y aceptación

- Un único escritor autoritativo publica cambios patrimoniales durante la migración. La sombra es lectura/comparación hasta un corte explícito.
- La fuente original, su interpretación y la decisión humana siguen consultables tras una corrección.
- La identidad de cuenta insuficiente impide fusionar posiciones por ticker o aplicar una operación sobre un saldo supuesto.
- Un snapshot tiene fecha económica y fecha de recepción; una carga antigua no debe sustituir silenciosamente una fotografía posterior.
- El mismo hecho económico respaldado por chat, foto y B3 se registra una sola vez. La relación entre evidencias conserva incertidumbre hasta confirmarse.
- Los movimientos de extractos B3 con períodos solapados conservan cada fila fuente, pero dos filas del mismo hecho no suman dos veces al saldo. Coincidencias sin identificador único quedan como candidatas hasta revisión; una carga repetida no crea otra operación.
- Una cotización o PTAX faltante produce valor ausente o parcial, no cero inventado.
- La aprobación concurrente de operaciones incompatibles debe conservar saldos válidos y un resultado auditable.
- Datos y documentos de Jorge y Julia no se atribuyen al otro titular sin evidencia explícita.
- Los flujos principales deben seguir operando sin Hermes; la ayuda de IA, si se incorpora, permanece opcional.

## 6. Pendientes de producto

Antes de conmutar la autoridad a PostgreSQL faltan reconciliación final de ambos titulares, cobertura de cuentas pendientes, migración verificable de originales, escritura patrimonial mediante las nuevas APIs, respaldo restaurable del conjunto y ensayo de reversión. Identidades individuales, escenarios guardados, alertas calculadas y proyección contractual son mejoras posteriores; su ausencia no debe describirse como una función ya entregada.

## 7. Estado verificable de capacidades (P0-02)

Esta matriz describe disponibilidad, no certifica aceptación integral. Una capacidad solo pasa a **validada** cuando se registra versión de código, escenario, resultado y fecha de prueba. La inspección de código no sustituye esa evidencia.

| Capacidad | Disponibilidad actual | Evidencia local / brecha |
|---|---|---|
| Consulta, importación y costos D1 | Vigente | `workspace/apps/web/app/api`; identidad de costos aún no incluye cuenta |
| Matriz anual/mensual y expansión por emisor | Vigente, parcial | `FixedIncomeProjection.tsx`; posiciones separadas por custodio/cuenta declarada; costos legados ambiguos quedan excluidos; falta identidad completa persistida |
| Propuestas D1 | Vigente | Rutas `transactions`; pruebas de aprobación en `workspace/apps/web/tests` |
| Evidencia manual, OCR y candidatos B3 | Sombra | `services/application` y `services/ingestion`; no publican hechos financieros en D1 |
| Cartera versionada y mercado independiente | Sombra | `services/application` y `services/market`; no reemplazan la autoridad vigente |
| Aprobación PostgreSQL | Módulo probado con datos sintéticos | No habilitado como escritor familiar por HTTP |
| Corrección integral con historial y publicación | Objetivo | Requiere completar conciliación y corte de autoridad |
| Proyección contractual, alertas calculadas y escenarios guardados | Objetivo | No confundir con estimación histórica y tarjetas actuales |

## 8. Reglas P0 aprobadas para implementación

Estas reglas precisan el objetivo; no implican que las brechas ya estén resueltas en código.

### P0-01 — Identidad de posiciones y adquisiciones

La identidad mínima es familia, titular, custodio, cuenta, instrumento y moneda. Una posición contiene adquisiciones separadas cuando difieren fecha, precio o condiciones relevantes. Dos cuentas con el mismo título se valoran por separado y solo se suman para presentación. Emisor y nombre comercial no son claves de posición. Una cuenta desconocida conserva su evidencia y un identificador provisional propio; nunca se fusiona con otra por tener el mismo ticker. Una transferencia confirmada enlaza origen/destino y conserva la adquisición; no simula una compra nueva.

**Aceptación:** dos cuentas del mismo titular con el mismo título y costos diferentes mantienen cantidades, costos e historial independientes; el total por emisor coincide con su suma. Un costo antiguo sin cuenta queda pendiente de asignación cuando hay más de una cuenta posible.

**Avance:** la proyección de renta fija separa titular, institución, cuenta declarada e instrumento. Si el reporte no declara cuenta, se conserva esa falta visible y la institución solo sirve como ámbito provisional. Un costo legado sin cuenta se usa únicamente cuando hay un solo candidato; ante posiciones homónimas se excluye y se explica en el detalle. Las migraciones 017/018 están aplicadas en la base de sombra y la API ofrece identidades con referencia de origen, candidatos de cuenta, resoluciones auditadas y registro/corrección versionada de lotes con actor, idempotencia y procedencia. Se cargaron las 170 filas de los reportes B3 más recientes: 149 posiciones de Jorge y 21 de Julia ya están ligadas a cuenta. Por confirmación del titular, se registró una cuenta de Julia para cada una de las tres instituciones presentes y se resolvieron las 21 identidades. Las 21 filas conservan `needs_review` como estado de interpretación; resolver custodia no valida sus datos financieros. No se generaron lotes, no se reasignó costo legado y nada de esto modifica la cartera publicada. Falta revisar esas filas y los costos históricos, además de integrar lotes aprobados a la proyección. El detalle de proyección muestra intervalo y fuentes de la serie, y advierte si alterna MTM con curva. Las referencias antiguas a la hoja se advierten cuando sus columnas no coinciden con los encabezados actuales; los registros existentes se conservan para revisión.

### P0-03 — Adquisición, valoración y conflictos

Se separan fecha de emisión, negociación/adquisición, liquidación y referencia del precio. El precio de compra se conserva en su moneda y por unidad, con cantidad y comisiones separadas; no se sustituye por MTM o curva. Una observación registra su método (compra, MTM, cierre o curva), fecha y fuente.

Un comprobante de operación inequívocamente vinculado a la adquisición prevalece sobre una cifra agregada para describir esa compra. Un snapshot acredita la posición a su corte, no necesariamente el costo. Una corrección explícita puede revisar el dato mediante decisión auditada. No hay prioridad automática universal de B3 sobre una foto o un mensaje: se evalúan identidad, tipo de dato y evidencia. Un conflicto conserva ambas afirmaciones y solicita revisión; nunca se borra el valor anterior. Una cabecera de hoja contradictoria requiere un mapeo documentado confirmado por el usuario.

**Aceptación:** la ficha explica de dónde proviene cada precio/fecha; cambiar un costo conserva valor previo, actor, razón y evidencia. Compras múltiples no se convierten en una compra ficticia con fecha única. Una serie que cambia entre curva y MTM se señala antes de extrapolarla.

**Avance:** se registraron 9 observaciones de adquisición B3 para 5 posiciones de Jorge; las comisiones se guardan como desconocidas porque el reporte no las declara. Al comparar la suma de lotes con el snapshot B3 del 19/10, 4 de las 5 posiciones concuerdan y una conserva una diferencia sin explicar con la evidencia disponible. La pestaña Revisiones ofrece una conciliación de solo lectura por titular y posición; compara compras brutas con el snapshot, identifica posiciones sin lotes y excluye diferencias no comparables cuando hay adquisiciones posteriores al corte. Son evidencias históricas en sombra; no se asignan al costo vigente ni alimentan la proyección hasta completar la conciliación de cantidades y la valoración histórica.

### P0-04 — Saldos y flujos por período

El saldo mensual es el valor de títulos vigentes al cierre. El saldo anual es el del cierre anual, nunca la suma de los saldos mensuales. Los vencimientos anuales son la suma de los flujos de vencimiento de los meses incluidos. El período de salida incluye el día exacto de vencimiento y ese título ya no integra el saldo de cierre. El dinero vencido se muestra como flujo proyectado; no se reinvierte ni se incorpora automáticamente a una cuenta de efectivo.

**Aceptación:** un título que vence el último día del mes aparece una vez como vencimiento y deja saldo cero en ese cierre. Expandir/colapsar conserva flujos y saldo final. El último año incompleto indica la fecha real de su corte. Saldos de distintas monedas solo se consolidan con conversión identificada y cobertura explícita.

### P0-05 — Tiempo y cobertura

Cada posición conserva fecha de snapshot, fecha de precio, recepción y alcance de movimientos. Se elige el snapshot económico más reciente válido dentro de cada ámbito documentado de fuente/cuenta; si el documento no declara su cobertura, una ausencia no prueba saldo cero. Una carga antigua no reemplaza una más reciente por haber llegado después.

La matriz inicia en la primera referencia cubierta del conjunto seleccionado. Antes de la referencia de una posición muestra «Sin cobertura», sin reconstruir retrospectivamente su saldo actual. Una fecha posterior de otro titular no recorta vencimientos ni movimientos anteriores del primero. Los totales de cada período se marcan parciales si falta cobertura de alguna posición seleccionada.

Un movimiento del mismo día del snapshot solo se aplica si existe evidencia de que ocurrió después de su corte; sin hora/secuencia suficiente queda pendiente. Negociación y liquidación se enlazan como etapas del mismo hecho cuando corresponde. No se interpola una historia patrimonial completa entre snapshots con movimientos incompletos.

**Aceptación:** con referencias de dos titulares distintas, se conserva un vencimiento entre ambas fechas; importar fuera de orden no cambia el snapshot vigente; un movimiento en el día del corte sin orden conocido no se contabiliza dos veces.

**Fuente de adquisición pendiente de confirmación:** la hoja «Investimentos», pestaña «Renda Fixa», en su estado actual, rotula G como «Data de Emissão» y L como «Preço Atualizado MTM». Se revisaron los encabezados de las 19 pestañas actuales y no se encontró una columna rotulada explícitamente como fecha o precio de compra. La revisión histórica más antigua consultada (25/02/2026) también rotula esos campos de Renda Fixa como emisión y MTM. No se importan G/L como compra. La pestaña «Renda Fixa Julia» usa otra estructura y L indica «Motivo», por lo que requiere mapeo independiente.
