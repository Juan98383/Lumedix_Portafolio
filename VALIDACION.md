# Validación de la copia de portafolio

Fecha: 9 de noviembre de 2026 (America/Bogota).

- Node.js de prueba: 24.19.0; Git disponible: 2.56.0.windows.4.
- Instalación de dependencias y carga del módulo nativo SQLite completadas.
- npm audit: 0 vulnerabilidades conocidas (informativas, bajas, moderadas, altas y críticas: 0). Resultado puntual, sujeto a nuevos avisos.
- Tres pruebas automatizadas: rutas y periodos, validación de PDF y conservación de bases existentes. Todas aprobadas.
- Arranque del servidor sobre una copia temporal independiente, sin usar bases originales.
- Respuesta HTTP correcta de la interfaz, los seis recursos principales de datos y las bibliotecas locales. La ruta de la base de datos no es pública (404).
- Host y Origin externos bloqueados (403); periodo malformado rechazado (400).
- Alta y eliminación de un cliente ficticio mediante la API verificadas.
- Navegador Edge sin ventana: interfaz sin errores JavaScript observados; Chart.js, XLSX 0.20.3, jsPDF y AutoTable cargados.
- Cadenas HTML maliciosas en campos de cliente se mostraron como texto; no crearon imágenes ejecutables. Argumento de periodo con intento de código no ejecutó la carga al pulsar el botón.
- Generación de documentos PDF con AutoTable y libros XLSX comprobada en el navegador.
- Se verificaron hashes SHA-256 de los archivos originales utilizados: sin cambios.
- El paquete de entrega no contiene bases, adjuntos, respaldos, node_modules ni historial Git.

Estas comprobaciones no constituyen una auditoría exhaustiva de toda la lógica contable ni una certificación para despliegue público. No se ha subido nada a GitHub.
