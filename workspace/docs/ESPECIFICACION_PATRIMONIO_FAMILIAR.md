# Patrimônio — Especificación funcional y técnica

**Estado documentado:** versión 18 publicada  
**Última actualización de la aplicación inspeccionada:** 19 de septiembre de 2026  
**Sitio:** <https://patrimonio-familiar-jorge.jorge-franchel681408.chatgpt.site>  
**Propietario y acceso actual:** Jorge; sitio privado con acceso restringido al propietario

## 1. Objetivo del producto

Patrimônio es una aplicación privada de gestión patrimonial familiar para Jorge y Julia. Centraliza posiciones, movimientos, costos, cotizaciones y documentos procedentes de distintas instituciones para ofrecer:

- una visión consolidada del patrimonio;
- seguimiento por titular, clase de activo, institución y moneda;
- costo de adquisición y lucro o perjuicio no realizado;
- control de vencimientos y proyecciones de renta fija;
- revisión humana de movimientos ambiguos;
- propuestas de ajuste de cartera originadas desde una conversación;
- recomendaciones explicables, sin ejecutar órdenes financieras.

El principio de trazabilidad es:

```text
archivo original
  -> registro bruto inmutable
  -> dato normalizado
  -> reconciliación o revisión
  -> posición consolidada
  -> valoración y proyección
  -> recomendación
```

La aplicación separa hechos importados, supuestos, cálculos proyectados y recomendaciones. Una ambigüedad debe permanecer visible y puede impedir conclusiones dependientes hasta que el usuario la resuelva.

## 2. Alcance actual

### Incluido

- Carteras de Jorge y Julia.
- Importación de posición y movimientos de B3 en Excel.
- Importación de extractos y confirmaciones de Avenue en PDF.
- Importación de previdência privada Santander en PDF.
- Registro manual de costo de compra.
- Cotizaciones automáticas de activos listados en Brasil y Estados Unidos.
- Conversión de activos en USD a BRL con PTAX.
- Revisión y clasificación manual de registros ambiguos.
- Chat para interpretar transacciones y proponer ajustes.
- Proyección experimental de renta fija a vencimiento.
- Simulación patrimonial genérica nominal y real.
- Exposición de consultas de solo lectura para conversar con ChatGPT desde el navegador compatible.

### Fuera del alcance actual

- Ejecución de órdenes de compra o venta.
- Integración directa con cuentas bancarias o corredoras mediante credenciales.
- Asesoría regulada o evaluación formal de suitability.
- Motor tributario, declaración fiscal o cálculo completo de ganancia realizada.
- Gestión integral de pasivos, inmuebles, participaciones privadas y activos no importados.
- Rentabilidad histórica completa mediante TWR, MWR o XIRR.
- Lectura OCR de comprobantes en imagen.
- Consulta pública completa de contratos privados de previdência.
- Automatización programada en segundo plano; la actualización automática de EE. UU. se inicia al abrir el panel.

## 3. Experiencia de usuario

La interfaz está organizada en pestañas para evitar una página excesivamente larga:

1. **Visão geral** — total consolidado, distribución, actividad B3, calidad de datos y acceso a la cartera completa.
2. **Revisões** — registros ambiguos y decisiones pendientes.
3. **Assistente** — conversación para interpretar operaciones y documentos.
4. **Importar** — importadores B3, Avenue y Santander.
5. **Renda fixa** — instrumentos, vencimientos y proyecciones.
6. **Projeções** — simulador patrimonial genérico.
7. **Recomendações** — alertas y sugerencias explicables.

La navegación es adaptable a escritorio y móvil y admite navegación por teclado.

### 3.1 Visión general

Muestra:

- patrimonio familiar total en BRL;
- subtotales de Jorge y Julia;
- fecha de referencia;
- PTAX usada en la conversión;
- distribución por clase de activo;
- actividad y estado de importaciones B3;
- indicadores de calidad de datos;
- cantidad de cotizaciones estadounidenses disponibles.

El botón **Ver carteira completa** abre una vista con filtros por titular y búsqueda por activo. Cada posición puede mostrar cantidad, precio actual, valor de mercado, costo y lucro o perjuicio no realizado.

El usuario puede registrar o corregir manualmente el costo de un activo. También puede solicitar una actualización de mercado manual.

## 4. Fuentes de datos e importadores

### 4.1 B3 — posición

**Formato:** `.xlsx`  
**Tamaño máximo:** 15 MB  
**Titular:** Jorge o Julia

Hojas reconocidas:

| Hoja B3 | Clase normalizada |
|---|---|
| Ações | `equity` |
| BDR | `bdr` |
| ETF | `etf` |
| Fundo de Investimento | `fund` |
| Renda Fixa | `fixed_income` |
| Tesouro Direto | `treasury` |

Campos normalizados cuando están disponibles:

- titular;
- clase de activo;
- producto;
- institución y cuenta;
- código del instrumento e ISIN;
- emisor;
- cantidad;
- precio unitario;
- valor de mercado;
- vencimiento;
- fecha de referencia;
- hoja y fila de origen;
- contenido bruto de la fila.

Para renta fija, la prioridad del valor importado es: **MTM**, luego **cierre**, luego **curva** y finalmente el valor genérico de la posición.

### 4.2 B3 — movimientos

**Formato:** `.xlsx`  
**Tamaño máximo:** 15 MB  
**Hoja esperada:** `Movimentação`

Clasificaciones principales:

- transferencia de entrada o salida;
- compra o venta;
- vencimiento;
- rescate anticipado;
- amortización;
- dividendo;
- juros sobre capital próprio;
- intereses o rendimientos;
- evento corporativo.

Los eventos corporativos y tipos desconocidos requieren revisión. El sistema no altera silenciosamente una posición cuando la interpretación no es segura.

### 4.3 Avenue — extracto mensual

**Formato:** PDF  
**Tamaño máximo:** 15 MB  
**Máximo:** 15 páginas

El documento debe contener identificadores compatibles con un estado de cuenta de Avenue, como `PORTFOLIO SUMMARY` y `TOTAL PRICED PORTFOLIO`.

Se extraen, según disponibilidad:

- acciones y opciones;
- renta fija internacional;
- fondos o money market;
- efectivo;
- cuenta, símbolo, cantidad, precio y valor en USD;
- fecha de referencia.

Clases usadas: `international_equity`, `international_fixed_income`, `money_market` y `cash`.

El extracto mensual establece una posición base. Las confirmaciones posteriores pueden ajustar cantidades y efectivo.

### 4.4 Avenue — confirmación o nota de corretaje

**Formato:** PDF  
**Tamaño máximo:** 15 MB  
**Máximo:** 15 páginas

Se interpretan:

- compra o venta;
- fecha de operación y liquidación;
- símbolo;
- cantidad;
- precio unitario;
- principal;
- comisiones;
- CUSIP, cuando existe.

Las confirmaciones posteriores a la fecha del extracto base se aplican a la posición consolidada.

### 4.5 Santander — previdência privada

**Formato:** PDF  
**Tamaño máximo:** 15 MB  
**Máximo:** 15 páginas

Regla de negocio específica: se considera solamente la **Conta Básica Participante**. El saldo de la empresa no liberado queda excluido.

Campos extraídos cuando están presentes:

- nombre del plan;
- saldo personal;
- cantidad de cuotas y valor de la cuota;
- fecha de referencia;
- fondo y CNPJ;
- certificado;
- modalidad PGBL o VGBL;
- proceso SUSEP;
- régimen tributario;
- posible fecha de salida.

La clase normalizada es `private_pension` y la moneda es BRL.

### 4.6 Controles comunes de importación

- El original se guarda en almacenamiento de objetos.
- Los datos normalizados se guardan en la base de datos.
- El hash SHA-256 del archivo evita duplicados para el mismo usuario y tipo de archivo.
- Una importación incompleta se revierte: se eliminan sus registros y el objeto asociado.
- Las inserciones se procesan por lotes para respetar el límite de parámetros de D1.
- Después de una importación exitosa, el botón queda desactivado para la misma huella de archivo durante la sesión de interfaz.
- La protección persistente contra duplicados está en el servidor mediante SHA-256.

## 5. Chat de transacciones

El asistente acepta texto y archivos para interpretar operaciones y sugerir el ajuste correspondiente.

### Entradas

- Texto, PDF, TXT, CSV, PNG, JPG y WEBP.
- Tamaño máximo por archivo: 15 MB.
- PDF: máximo 20 páginas.
- Mensaje: máximo 3.000 caracteres.

### Comportamiento

1. El sistema interpreta la operación de forma determinística.
2. Para confirmaciones Avenue usa un parser especializado.
3. Genera una propuesta, nunca una ejecución automática.
4. El usuario debe **aprobar** o **rechazar**.
5. Una propuesta aprobada crea un registro inmutable de tipo `chat_transaction`.
6. Si la fecha es posterior a la posición base, la operación ajusta la cartera consolidada.

Estados: `pending`, `applied`, `rejected` y `duplicate`.

La detección de duplicados considera titular, lado de la operación, instrumento, fecha, cantidad y precio unitario.

**Limitación:** las imágenes se almacenan, pero actualmente no existe OCR ni visión para extraer automáticamente su contenido.

## 6. Revisiones humanas

Los registros que requieren revisión muestran su archivo, hoja/fila y contexto de origen. El usuario puede clasificarlos como:

- `corporate_action`;
- `custody_transfer`;
- `position_adjustment`;
- `ignored`.

Puede añadirse una nota de hasta 500 caracteres. La decisión está aislada por usuario y la actualización es idempotente: existe una única decisión activa por usuario y registro.

## 7. Valorización y cotizaciones

### 7.1 Activos listados en Brasil

La fuente de cierre es el archivo público diario **COTAHIST de B3**.

- Se busca la fecha solicitada y días anteriores.
- La ventana máxima es de 14 días, considerando hasta siete días hábiles candidatos.
- Se prioriza el tipo de mercado 010.
- No requiere clave ni suscripción.

Para valores de renta fija importados, la prioridad es:

```text
MTM -> cierre -> curva -> valor de posición
```

### 7.2 Activos listados en Estados Unidos

La solución actual no usa Google Finance, porque Google no ofrece una API pública y estable equivalente a la función de Google Sheets.

Fuentes implementadas:

1. endpoint público de gráficos de Yahoo Finance;
2. información pública de Nasdaq como alternativa.

Reglas operativas:

- sin API key y sin costo contratado;
- timeout de cinco segundos por consulta;
- concurrencia máxima de ocho símbolos;
- símbolos con punto se convierten a guion cuando corresponde;
- al abrir el panel se actualizan solo cotizaciones ausentes o con más de seis horas;
- la actualización manual incluye activos de EE. UU. y Brasil.

Estas fuentes son públicas, pero no constituyen APIs comerciales con SLA. Pueden cambiar, limitar solicitudes o quedar temporalmente indisponibles.

### 7.3 Conversión USD/BRL

La PTAX se obtiene del servicio Olinda del Banco Central do Brasil. Se busca la cotización más reciente en una ventana de 14 días.

Cuando existe precio de mercado actual para una posición Avenue:

```text
valor en BRL = cantidad × cotización en USD × PTAX
```

Si no existe cotización actual, se conserva el valor procedente del extracto o de las confirmaciones.

### 7.4 Costo y lucro o perjuicio

El costo puede originarse en:

- registro manual;
- movimientos o notas de corretaje reconocidas;
- información histórica disponible en la fuente.

Las compras posteriores actualizan el costo medio ponderado. Las ventas reducen la cantidad, pero el sistema actual no implementa lotes fiscales ni cálculo tributario completo.

```text
lucro/perjuicio no realizado = valor de mercado actual - costo de la posición
```

El resultado solo se muestra cuando existe una base de costo utilizable.

## 8. Renta fija y proyección a vencimiento

### 8.1 Datos usados

Las observaciones de precio se agrupan por titular e instrumento a través de distintas importaciones. Puede incorporarse un costo manual como observación histórica si su fecha precede a la observación actual.

Se necesitan, como mínimo:

- dos precios positivos;
- dos fechas diferentes;
- fecha de vencimiento válida.

### 8.2 Fórmula actual

Para el primer precio `P0`, el último precio `P1` y `d` días transcurridos:

```text
rentabilidad del período = P1 / P0 - 1
rentabilidad anualizada = (P1 / P0)^(365,25 / d) - 1
precio proyectado = P1 × (1 + rentabilidad anualizada)^(días hasta vencimiento / 365,25)
valor proyectado = precio proyectado × cantidad
```

La extrapolación se rechaza si la rentabilidad anualizada no es finita, es menor o igual a -95 % o supera 200 %.

### 8.3 Confianza

| Nivel | Regla |
|---|---|
| Alta | al menos 4 observaciones y 180 días de historial |
| Media | al menos 3 observaciones y 90 días de historial |
| Baja | cumple mínimos, pero no los umbrales anteriores |
| Insuficiente | faltan observaciones, fechas, vencimiento o la variación no es extrapolable |

### 8.4 Advertencia importante

Este modelo es **experimental**. Extrapola la variación observada del precio y no representa necesariamente la tasa contractual del título. No modela de forma completa:

- CDI, IPCA, cupón o spread contractual;
- calendario de pagos;
- amortizaciones y cupones intermedios;
- impuestos y costos;
- rescate anticipado;
- riesgo de crédito;
- curva de mercado futura.

Un historial corto puede producir proyecciones económicamente absurdas aun dentro del límite del 200 % anual. Por lo tanto, la cifra no debe usarse para decisiones financieras hasta sustituir el modelo por flujos contractuales, indexadores y tasas del instrumento.

## 9. Simulador patrimonial

La pestaña de proyecciones incluye un simulador genérico con:

- patrimonio inicial;
- rentabilidad anual nominal;
- inflación anual;
- horizonte en años.

Entrega valor nominal y valor real estimado. No incorpora aportes, rescates, impuestos, costos ni composición específica de la cartera.

## 10. Recomendaciones

La interfaz actual presenta recomendaciones basadas en reglas, entre ellas:

- revisar concentración por emisor por encima de R$ 250.000, considerando titular, grupo económico y cobertura;
- preparar vencimientos y reinversión;
- reconciliar eventos ambiguos antes de confiar en conclusiones dependientes.

Las recomendaciones son informativas, explicables y no ejecutan órdenes. La versión productiva actual todavía no contiene un motor completo de optimización, suitability o planificación fiscal.

## 11. Integración conversacional con ChatGPT

La aplicación registra, cuando se abre dentro de un navegador compatible con ChatGPT, cinco herramientas WebMCP de solo lectura:

1. `consultar_resumo_patrimonial`;
2. `consultar_posicoes`;
3. `consultar_concentracoes`;
4. `consultar_vencimentos_e_projecoes`;
5. `consultar_revisoes_pendentes`.

Esto permite conversar sobre los datos actuales del sitio sin dar al agente capacidad para modificar la cartera o ejecutar operaciones.

**Distinción técnica:** estas herramientas viven en el navegador mediante `document.modelContext`. El proyecto no declara actualmente un servidor MCP alojado por Sites; por eso no existe un endpoint MCP remoto autónomo para consultar el patrimonio fuera de la sesión del sitio.

## 12. Arquitectura técnica

### 12.1 Aplicación productiva

- **Frontend/full stack:** React 19.2.6, TypeScript 5.9.3 y Vinext 1.0.0 beta 2.
- **Build:** Vite 8.
- **Estilos:** Tailwind CSS 4.
- **Runtime:** Cloudflare Workers mediante OpenAI Sites.
- **Base de datos:** Cloudflare D1, compatible con SQLite.
- **ORM y migraciones:** Drizzle ORM / Drizzle Kit.
- **Archivos originales:** Cloudflare R2.
- **Excel:** SheetJS 0.20.3.
- **PDF:** unpdf 1.8.
- **Archivos ZIP de COTAHIST:** fflate.
- **Autenticación:** encabezado de usuario autenticado inyectado por Sites; fallback limitado al desarrollo local.

El repositorio contiene también un prototipo anterior o paralelo en Python/FastAPI con un modelo orientado a PostgreSQL. La aplicación publicada usa el stack web/Worker/D1/R2 descrito arriba; el prototipo no debe considerarse la fuente productiva de verdad.

### 12.2 Flujo de datos

```text
Navegador
  -> rutas API del Worker
      -> validación y parser de fuente
      -> R2: archivo original
      -> D1: importación + registros normalizados
      -> reconciliación, cotización y consolidación
  <- panel, revisiones, proyecciones y propuestas
```

### 12.3 Modelo de datos

#### `imports`

Representa una importación o transacción aprobada.

- identificador y usuario;
- titular;
- tipo: `positions`, `movements`, `avenue_statement`, `avenue_confirmation`, `pension_statement` o `chat_transaction`;
- nombre, SHA-256 y clave del objeto;
- fecha de referencia;
- cantidad de registros y valor de mercado;
- indicador de revisión;
- estado y fecha de creación.

Restricción principal: combinación única de usuario, SHA-256 y tipo.

#### `import_records`

Contiene cada posición o evento normalizado:

- importación de origen;
- clase de registro;
- hoja y fila;
- tipo de evento;
- indicador de revisión;
- payload JSON con campos normalizados y datos brutos necesarios para auditoría.

#### `review_decisions`

Guarda la decisión humana para un registro. Es única por usuario y registro.

#### `cost_basis`

Guarda el costo por usuario, titular, instrumento y moneda. Esa combinación es única.

#### `market_quotes`

Guarda cotizaciones por usuario, mercado y símbolo. Esa combinación es única.

#### `chat_messages`

Histórico de mensajes y anexos del asistente de transacciones.

#### `transaction_proposals`

Propuestas extraídas por el chat, su estado y la decisión posterior.

### 12.4 Selección de posiciones

La consolidación parte, en general, de la importación de posiciones procesada más reciente por titular y tipo. Encima de esa base se aplican movimientos o confirmaciones posteriores compatibles.

## 13. API interna

| Método | Ruta | Función |
|---|---|---|
| POST | `/api/import/b3` | Importar posición o movimientos B3 |
| POST | `/api/import/avenue` | Importar extracto o confirmación Avenue |
| POST | `/api/import/pension` | Importar extracto Santander |
| POST | `/api/market/refresh` | Actualizar cotizaciones y PTAX |
| GET | `/api/portfolio/dashboard` | Datos consolidados del panel |
| GET | `/api/portfolio/positions` | Posiciones detalladas |
| GET | `/api/portfolio/summary` | Resumen patrimonial |
| POST | `/api/portfolio/cost-basis` | Registrar o actualizar costo manual |
| GET | `/api/portfolio/fixed-income-projection` | Proyecciones de renta fija |
| POST | `/api/portfolio/reviews/:id` | Resolver una revisión |
| GET/POST | `/api/transactions/chat` | Consultar o enviar mensajes y documentos |
| POST | `/api/transactions/proposals/:id` | Aprobar o rechazar una propuesta |

Las rutas aíslan los datos por usuario autenticado y validan el titular contra Jorge y Julia cuando corresponde.

## 14. Seguridad, privacidad y trazabilidad

Controles implementados:

- sitio privado y acceso restringido;
- identificación del usuario proporcionada por la plataforma;
- aislamiento de consultas por `user_id`;
- validación de titular;
- límites de tipo, tamaño y páginas;
- deduplicación por SHA-256;
- nombres de objeto sanitizados;
- mensajes de error externos limitados a información segura;
- archivos originales conservados en R2;
- registros normalizados con referencia a fuente, hoja y fila;
- revisiones y decisiones con marca temporal;
- ninguna capacidad de ejecución automática de órdenes;
- ninguna credencial de cotización embebida en el código.

Pendientes de hardening:

- no existe escaneo explícito de malware;
- no hay política de retención, exportación o eliminación de datos accesible al usuario;
- no existe un log de auditoría independiente más allá de importaciones, decisiones y timestamps;
- no hay OCR para anexos de imagen;
- las fuentes públicas de cotización no ofrecen garantía de disponibilidad;
- el sitio podría compartirse en el futuro mediante un cambio explícito de la política de acceso de Sites;
- los documentos originales no tienen todavía una función de eliminación desde la interfaz.

## 15. Calidad, pruebas y operación

La suite incluye pruebas para:

- parser B3;
- parser de extracto y confirmación Avenue;
- parser de previdência Santander;
- lectura de COTAHIST;
- cálculo de proyección de renta fija;
- parser del chat de transacciones;
- fallback del proveedor de mercado estadounidense;
- renderizado HTML del servidor.

Última verificación conocida de la versión publicada: build exitoso y 19 pruebas aprobadas.

Comandos principales del módulo web:

```bash
npm run dev
npm run build
npm run test
npm run db:generate
```

La aplicación publicada corresponde a la versión 18 del proyecto de Sites.

## 16. Limitaciones y deuda técnica conocidas

### Prioridad alta

1. **Rediseñar la proyección de renta fija.** Debe usar tasa contractual, indexador, calendario de flujos, amortizaciones y tributación; el modelo actual basado en dos precios puede distorsionar severamente el resultado.
2. **Crear observabilidad de cotizaciones.** Mostrar fuente, hora, antigüedad y error por activo, además de reintentos controlados.
3. **Persistir mejor el estado del importador.** La desactivación visual posterior al éxito dura la sesión; la protección real está en el servidor, pero la interfaz debería consultar y mostrar el histórico.
4. **Agregar OCR o visión segura.** Hoy los comprobantes en imagen se guardan, pero no se interpretan.
5. **Implementar auditoría y reversión controlada.** Debe existir un historial explícito de cambios y una forma segura de anular un ajuste aprobado sin borrar evidencia.

### Prioridad media

6. Incorporar benchmarks, rentabilidad por período, TWR y XIRR.
7. Implementar lotes fiscales, ganancias realizadas e impuestos por jurisdicción.
8. Modelar tipos de cambio históricos en lugar de usar únicamente la PTAX más reciente.
9. Incorporar pasivos, inmuebles, efectivo bancario y activos no custodiados en B3/Avenue.
10. Sustituir recomendaciones estáticas por reglas versionadas y explicaciones basadas en datos actuales.
11. Crear un MCP alojado y autenticado si se desea usar el asesor fuera de la pestaña abierta del sitio.

### Elementos actualmente fijos en la interfaz

- El indicador de calidad `82` no se calcula dinámicamente.
- El texto de última posición B3 contiene una fecha fija.
- El simulador genérico nace con un patrimonio inicial preconfigurado.

Estos valores deben derivarse de datos o quedar claramente marcados como ejemplo/configuración.

## 17. Roadmap recomendado

### Fase 1 — Confiabilidad de la fuente de verdad

- histórico de importaciones visible;
- estado persistente de duplicados;
- auditoría y reversión;
- cobertura de instrumentos sin código;
- diagnóstico de cotizaciones por activo.

### Fase 2 — Rentabilidad y renta fija

- contratos y flujos de renta fija;
- CDI, SELIC, IPCA y curvas;
- cupones, amortizaciones e impuestos;
- costo histórico por lotes;
- TWR, XIRR y benchmarks.

### Fase 3 — Asesor conversacional

- herramientas MCP remotas de solo lectura;
- referencias a la fuente de cada afirmación;
- simulaciones de escenarios;
- propuestas de rebalanceo sujetas a aprobación;
- memoria de objetivos, restricciones y tolerancia al riesgo separada de los datos transaccionales.

### Fase 4 — Cobertura patrimonial completa

- cuentas bancarias y efectivo;
- inmuebles y pasivos;
- seguros y otros planes de previdência;
- activos privados;
- planificación tributaria y sucesoria con especialistas.

## 18. Criterios rectores para futuras evoluciones

1. Ningún documento ambiguo debe modificar la cartera sin revisión.
2. Todo valor consolidado debe poder rastrearse hasta su fuente.
3. Toda cotización debe informar fuente y antigüedad.
4. Toda proyección debe declarar supuestos, fórmula y nivel de confianza.
5. Toda recomendación debe explicar la evidencia que la originó.
6. Ningún asistente debe ejecutar una orden financiera.
7. Los datos de Jorge y Julia deben permanecer privados y aislados por usuario.
8. Las fuentes gratuitas deben tener fallback y degradación visible.
9. Un error de importación no debe dejar datos parciales.
10. El sistema debe distinguir claramente saldo actual, costo, ganancia realizada, ganancia no realizada y proyección.

---

Este documento describe la aplicación tal como fue implementada y publicada en la versión indicada. No constituye recomendación financiera, jurídica, tributaria ni contractual.
