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

## 3. Recorridos vigentes

### Consulta y valoración

La vista general muestra patrimonio consolidado en BRL, subtotales por titular, clases de activo, actividad y calidad de datos. La cartera permite consultar cantidades, valor, costo y resultado no realizado cuando existe base suficiente. Un tipo de cambio ausente o una identidad incierta debe ser visible; no se inventa un total completo. Las cotizaciones brasileñas, estadounidenses y USD/BRL provienen de procesos o consultas de mercado con fecha y fuente identificables.

La web dispone de simulación nominal/real con parámetros editables. Sus tarjetas de recomendaciones actuales son orientación de interfaz; no deben presentarse como recomendaciones financieras calculadas a partir de toda la cartera.

### Importación y conciliación

1. El usuario elige titular y fuente, envía el documento y ve su estado.
2. Se conserva el original y se registran hash, fecha, tipo, hoja/fila o página y resultado del parser.
3. El parser extrae afirmaciones. Un archivo idéntico no duplica hechos.
4. El sistema compara por titular, custodio, cuenta, instrumento y tiempo. Una diferencia o identidad incompleta pasa a revisión.
5. La decisión humana queda trazada; la corrección conserva la evidencia anterior.

Los archivos B3 de **posición** son fotografías patrimoniales con fecha de corte. Los de **movimientos** ofrecen historia de entradas, salidas y eventos. El movimiento ya incluido en una fotografía no vuelve a sumarse sobre ella. La conciliación distingue compra/venta, liquidación, transferencia, rendimiento, amortización, rescate y evento corporativo. Dos filas parecidas pueden ser evidencias del mismo hecho, pero esa relación se valida antes de afectar cantidades.

Avenue aporta extractos de posición y confirmaciones; la previsión aporta saldo del participante según el documento del proveedor. Una foto o un movimiento escrito se guarda desde su recepción aun si OCR, cuenta, fecha o interpretación quedan pendientes. La sombra dispone de carga documental, OCR local para formatos compatibles y bandejas de candidatos; su aplicación al patrimonio autoritativo sigue bajo revisión.

### Movimientos y aprobaciones

El chat transaccional interpreta texto o comprobantes y prepara una propuesta. Antes de aprobar se muestran titular, activo, lado, cantidad, precio, moneda, fecha, cuenta y comisiones disponibles. Campos ausentes o ambiguos requieren completar o revisar. Aprobar o rechazar es una acción explícita; una consulta nunca aprueba. La aprobación debe ser idempotente y no puede aplicar dos veces una misma propuesta. No se ejecutan órdenes de inversión.

El chat guiado propio responde consultas habituales sin Hermes. El chat libre mediante Hermes permanece como integración heredada opcional. **Objetivo:** todos los recorridos patrimoniales habituales funcionan con Hermes detenido; un modelo directo puede ayudar a interpretar lenguaje libre, pero no decide custodia, deduplicación ni aprobaciones.

### Revisiones y costos

Las revisiones muestran evidencia, motivo, titular, cuenta y efecto posible. La web vigente permite decidir registros ambiguos y la sombra conserva decisiones auditadas sobre vínculos y conciliaciones. Vincular una foto o una fila B3 a un mensaje expresa correspondencia de evidencia; no autoriza a contabilizar una operación.

El costo de adquisición puede proceder de una compra documentada, un dato manual o una fuente histórica. Para la renta fija de Jorge se incorporaron precios y fechas de una hoja de inversión contrastados con las cantidades del snapshot B3; donde existía una compra B3 más precisa se conservó la transacción. Los costos se atribuyen al titular y al instrumento, con fecha y procedencia, sin confundir precio de compra con precio de mercado.

## 4. Renta fija: histórico y proyección

La proyección vigente toma observaciones de precio por titular e instrumento, incluida la adquisición cuando precede al último valor. Requiere dos fechas con precios positivos y vencimiento válido. Anualiza la variación observada y compone el precio hasta cada período y hasta el vencimiento. La tasa obtenida **no equivale necesariamente a la tasa contractual**. No modela completamente CDI/IPCA, cupones, amortizaciones, impuestos, rescate anticipado ni riesgo de crédito. Una serie corta se identifica como de baja confianza; tasas fuera del intervalo admitido se excluyen.

La pantalla presenta una matriz horizontal. Cada año ocupa una columna expandible a meses; cada fila agrupa un emisor y se expande a sus títulos. El filtro separa a Jorge y Julia. En cada celda, el saldo proyectado representa títulos que siguen vigentes al corte; los vencimientos del período se muestran aparte. Un título deja de sumar al saldo después de vencer. Los títulos sin tasa o fecha suficientes permanecen identificables, pero no aportan importes inventados a la serie.

**Objetivo:** incorporar condiciones contractuales e indexadores por título antes de utilizar proyecciones para decisiones de inversión. Conservar en paralelo la estimación basada en histórico, etiquetada con su método y cobertura.

## 5. Reglas de integridad y aceptación

- Un único escritor autoritativo publica cambios patrimoniales durante la migración. La sombra es lectura/comparación hasta un corte explícito.
- La fuente original, su interpretación y la decisión humana siguen consultables tras una corrección.
- La identidad de cuenta insuficiente impide fusionar posiciones por ticker o aplicar una operación sobre un saldo supuesto.
- Un snapshot tiene fecha económica y fecha de recepción; una carga antigua no debe sustituir silenciosamente una fotografía posterior.
- El mismo hecho económico respaldado por chat, foto y B3 se registra una sola vez. La relación entre evidencias conserva incertidumbre hasta confirmarse.
- Una cotización o PTAX faltante produce valor ausente o parcial, no cero inventado.
- La aprobación concurrente de operaciones incompatibles debe conservar saldos válidos y un resultado auditable.
- Datos y documentos de Jorge y Julia no se atribuyen al otro titular sin evidencia explícita.
- Los flujos principales deben seguir operando sin Hermes; la ayuda de IA, si se incorpora, permanece opcional.

## 6. Pendientes de producto

Antes de conmutar la autoridad a PostgreSQL faltan reconciliación final de ambos titulares, cobertura de cuentas pendientes, migración verificable de originales, escritura patrimonial mediante las nuevas APIs, respaldo restaurable del conjunto y ensayo de reversión. Identidades individuales, escenarios guardados, alertas calculadas y proyección contractual son mejoras posteriores; su ausencia no debe describirse como una función ya entregada.
