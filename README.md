# Juanca

Aplicación privada para consultar y registrar el patrimonio familiar de Jorge y Julia. La web actual y D1 siguen siendo la autoridad financiera; la aplicación PostgreSQL y los servicios de ingesta y mercado funcionan en sombra mientras se verifica la migración.

La documentación vigente está consolidada en tres documentos:

- [Especificación funcional](docs/ESPECIFICACION_FUNCIONAL.md): reglas de negocio, fuentes, recorridos y condiciones de aceptación.
- [Especificación técnica](docs/ESPECIFICACION_TECNICA.md): componentes, datos, contratos, seguridad, operación y migración.
- [Especificación UX](docs/ESPECIFICACION_UX.md): navegación, matriz de renta fija, estados e interacciones.

El código de la web vigente está en `workspace/apps/web`; los servicios nuevos en `services`; los contratos en `packages/contracts`; y las migraciones y utilidades en `infra`. Los datos, documentos originales, claves y respaldos son privados y no forman parte del repositorio.
