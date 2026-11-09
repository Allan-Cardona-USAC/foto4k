# Foto4K

Aplicación web para **ampliar fotos a 4K con inteligencia artificial sin perder nada del original**.
La IA corre dentro del navegador de cada persona, así que el sitio puede ser gratis para miles de
usuarios: Vercel solo sirve archivos estáticos y las fotos nunca se suben a ningún servidor.

## Qué hace

- Amplía a **4K** (lado largo de 3840 px), **4K UHD** (cabe en 3840 × 2160), **×2** o **×4**.
- **No recorta ni deforma**: respeta siempre la proporción de la foto.
- **Nunca reduce el original** antes de procesarlo. Si la foto ya mide 4K o más, te avisa.
- **Mantiene los colores**: tras la IA, compara con el original y corrige cualquier desvío de color o brillo.
- **Conserva los datos EXIF** (cámara, fecha, ubicación) y corrige la orientación.
- Descarga en **PNG sin pérdida** (o JPG si prefieres un archivo más liviano). Respeta la transparencia.
- Comparador **antes / después** con zoom, y avance en vivo bloque por bloque.
- Funciona con la **tarjeta gráfica** (WebGPU) y, si no hay, con el **procesador** (WebAssembly).
- Interfaz en español, sin cuentas, sin anuncios y sin rastreo.

## Cómo funciona

```
Navegador de la persona
 ├─ index.html · styles.css · app.js     ← Vercel (archivos estáticos, ~100 KB)
 └─ worker.js (hilo aparte, la página no se congela)
     ├─ Transformers.js 4.3.1             ← jsDelivr (CDN gratuito)
     ├─ Modelo Swin2SR en ONNX (8–55 MB)  ← Hugging Face (se guarda en caché tras la 1.ª vez)
     └─ WebGPU (tarjeta gráfica) o WASM (procesador)
```

Pasos del procesamiento (`public/js/core/`):

1. **Lectura**: el navegador abre la foto y aplica la orientación EXIF.
2. **Plan** (`plan.js`): decide cuántas pasadas de IA hacen falta (máximo 2). Si la foto es muy
   pequeña, primero la amplía con Lanczos. El original nunca se reduce.
3. **Bloques** (`tiles.js`, `pipeline.js`): la IA procesa la imagen en bloques con un margen de
   contexto y solo conserva el centro de cada uno, así no se notan las uniones y la memoria de la GPU
   queda acotada.
4. **Ajuste al tamaño exacto** (`resample.js`): reducción Lanczos-3 por bandas, verificada contra Pillow.
5. **Fidelidad de color** (`enhance.js`): se reduce el resultado al tamaño original, se mide la
   diferencia de baja frecuencia y se corrige. El detalle fino de la IA no se toca.
6. **Nitidez extra** opcional (máscara de enfoque sobre la luminancia).
7. **Guardado** en PNG o JPG, con el EXIF original adaptado (`metadata.js`).

Si la tarjeta gráfica falla o devuelve algo incorrecto (se verifica el primer bloque), la app
continúa sola con el procesador.

### Tipos de foto (modelos)

| Opción en pantalla           | Modelo                                         | Escala | Descarga |
| ---------------------------- | ---------------------------------------------- | ------ | -------- |
| Foto de celular o cámara     | `Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr` | ×4     | ~54 MB   |
| Foto nítida y limpia         | `Xenova/swin2SR-classical-sr-x2-64`            | ×2     | ~54 MB   |
| Muy comprimida o pixelada    | `Xenova/swin2SR-compressed-sr-x4-48`           | ×4     | ~55 MB   |
| Rápido                       | `Xenova/swin2SR-lightweight-x2-64`             | ×2     | ~8 MB    |
| Sin IA                       | Lanczos-3 (matemático)                         | libre  | nada     |

Son modelos orientados a la **fidelidad** (entrenados para parecerse al original, no para inventar
texturas). Si el equipo no tiene tarjeta gráfica compatible, la app propone «Rápido» por defecto.

## Lo que necesitas

- Una cuenta gratuita de **GitHub** y otra de **Vercel** (plan Hobby).
- Para probar en tu computadora: **Node.js 20 o superior** (opcional; no hay dependencias que instalar).
- Un navegador actualizado (Chrome, Edge, Safari o Firefox).

## Probar en tu computadora

```bash
npm run dev
```

Abre <http://localhost:3000>. No hace falta `npm install`: el proyecto no tiene dependencias.
El servidor local envía los mismos encabezados que Vercel.

Pruebas automáticas (plan de tamaños, bloques, Lanczos contra Pillow, fidelidad de color, EXIF):

```bash
npm test
```

## Publicar gratis en Vercel

### Opción A: desde la web (recomendada)

1. Crea un repositorio nuevo en GitHub, por ejemplo `foto4k`.
2. Sube el contenido de esta carpeta. Desde la web de GitHub: **Add file → Upload files** y arrastra
   todos los archivos y carpetas. O con la terminal:

   ```bash
   git init
   git add .
   git commit -m "Primera versión de Foto4K"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/foto4k.git
   git push -u origin main
   ```

3. Entra a [vercel.com](https://vercel.com) y regístrate con tu cuenta de GitHub (plan **Hobby**, gratis).
4. Pulsa **Add New… → Project**, elige el repositorio `foto4k` y pulsa **Import**.
5. No cambies nada: `vercel.json` ya indica que es un sitio estático dentro de `public/`.
   Pulsa **Deploy**.
6. En unos segundos tendrás tu dirección, por ejemplo `https://foto4k.vercel.app`.
   Cada vez que subas cambios a GitHub, Vercel publica la nueva versión automáticamente.

### Opción B: con la terminal (Vercel CLI)

```bash
npm i -g vercel
vercel          # la primera vez inicia sesión y crea el proyecto (vista previa)
vercel --prod   # publica en producción
```

### Comprobar que quedó bien

Abre tu sitio, pulsa F12 → **Consola** y escribe `crossOriginIsolated`. Debe responder `true`
(significa que los encabezados de `vercel.json` están activos y la IA puede usar varios núcleos del
procesador cuando no hay tarjeta gráfica). Luego amplía una foto de prueba.

### Dominio propio (opcional)

En Vercel: **Project → Settings → Domains** y agrega tu dominio.

## Estructura del proyecto

```
foto4k/
├─ public/                  ← todo lo que se publica
│  ├─ index.html            interfaz
│  ├─ styles.css            diseño (colores y tipografía al inicio)
│  ├─ favicon.svg
│  └─ js/
│     ├─ app.js             lógica de la interfaz y comparador
│     ├─ worker.js          IA en segundo plano (Transformers.js, WebGPU/WASM)
│     ├─ models.js          catálogo de modelos y versión de Transformers.js
│     └─ core/              procesamiento puro, sin dependencias
│        ├─ plan.js         tamaños y pasadas
│        ├─ tiles.js        división en bloques
│        ├─ pipeline.js     orquestador por bloques
│        ├─ resample.js     Lanczos por bandas
│        ├─ enhance.js      fidelidad de color y nitidez
│        └─ metadata.js     EXIF (leer, adaptar, insertar)
├─ tests/                   pruebas con node:test
├─ scripts/dev-server.mjs   servidor local
├─ vercel.json              configuración de Vercel
└─ package.json
```

## Personalizar

- **Textos**: `public/index.html` (y mensajes de estado en `public/js/app.js`).
- **Colores y tipografía**: variables al inicio de `public/styles.css`.
- **Modelos**: `public/js/models.js`. Cada modelo tiene `repo`, `scale`, `tile` y, opcionalmente,
  `dtype` por dispositivo, por ejemplo `dtype: { webgpu: 'fp16', wasm: 'q8' }` para descargas más
  pequeñas (con algo menos de calidad).
- **Versión de Transformers.js**: constante `TRANSFORMERS_URL` en `models.js`. Prueba antes de publicar.
- **Tamaño máximo de salida**: `MAX_OUTPUT_PIXELS` en `public/js/core/plan.js` (48 MP por defecto).

## Costos y límites

- **Vercel Hobby es gratis, pero solo para uso personal y no comercial.** Si más adelante agregas
  anuncios, pagos o la usas para un negocio, necesitas el plan Pro (20 USD al mes).
- El sitio pesa unos 100 KB y **los modelos no pasan por Vercel** (vienen de Hugging Face), así que la
  transferencia mensual incluida en Hobby (100 GB) alcanza para muchísimas visitas.
- Hugging Face y jsDelivr son CDN públicos y gratuitos.
- No hay servidores, API de pago ni base de datos: el costo no crece con la cantidad de usuarios.

## Compatibilidad

- **Con tarjeta gráfica (WebGPU)**: Chrome y Edge 113+, Safari 26+ (Mac, iPhone, iPad),
  Firefox 141+ en Windows y en Mac con Apple Silicon (145+), Chrome 121+ en muchos teléfonos Android.
- **Sin WebGPU** funciona igual con el procesador, pero más lento: usa «Rápido».
- **HEIC** (iPhone): solo Safari puede abrirlas. En otros navegadores conviértelas a JPG.
- El navegador convierte los colores a sRGB. Fotos con perfil de color amplio (Display P3) pierden
  algo de gama en tonos muy saturados.

## Qué esperar de la IA

Ninguna herramienta puede recuperar detalles que la cámara nunca captó. La IA estima el detalle más
probable: bordes más limpios, menos ruido y menos bloques de compresión. Por eso se usan modelos que
priorizan la fidelidad, y la app garantiza lo que sí se puede garantizar: sin recortes, sin
deformación, colores fieles, metadatos conservados y archivo sin pérdida.

El tiempo depende de la foto y del equipo: con tarjeta gráfica suele ir de segundos a pocos
minutos; solo con el procesador puede tardar bastante más (por eso existe el tipo «Rápido»).

## Solución de problemas

- **«No se pudo descargar la IA»**: revisa la conexión. Algunas redes bloquean `huggingface.co` o
  `cdn.jsdelivr.net`.
- **Va muy lento**: el navegador no tiene acceso a la tarjeta gráfica. Actualízalo, activa la
  «aceleración por hardware» en la configuración de Chrome o usa «Rápido».
- **«Tu dispositivo se quedó sin memoria»**: elige 4K UHD, el tipo «Rápido» o cierra otras pestañas.
- **Funciona en local pero no en Vercel**: confirma que `vercel.json` está en la raíz del repositorio
  y que `crossOriginIsolated` da `true` en la consola.

## Ideas para seguir

- Procesar varias fotos a la vez (lote) y descargarlas en un ZIP.
- Un modo «más nítido» con un modelo GAN (Real-ESRGAN) para quien prefiera nitidez sobre fidelidad.
- Instalable como app (PWA) y uso sin conexión una vez descargado el modelo.
- Codificador PNG propio sin canal alfa: archivos alrededor de 25 % más livianos.
- Abrir HEIC en cualquier navegador con un decodificador en WebAssembly.
- Agregar una política de seguridad de contenido (CSP).

## Licencias y créditos

- Código de Foto4K: licencia MIT (ver `LICENSE`).
- Modelos Swin2SR: Conde, Choi, Burchi y Timofte, *Swin2SR: SwinV2 Transformer for Compressed Image
  Super-Resolution and Restoration* ([arXiv:2209.11345](https://arxiv.org/abs/2209.11345)),
  Universidad de Würzburg, licencia Apache 2.0. Conversión a ONNX de Hugging Face.
- [Transformers.js](https://huggingface.co/docs/transformers.js) (Apache 2.0) y ONNX Runtime Web (MIT).
