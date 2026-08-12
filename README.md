# MB Services — Administración y Contabilidad

App de administración y contabilidad para MB Services: trabajos, nómina, materiales
(con escaneo de facturas por IA), cuentas bancarias, reembolsos y reportes de cierre.

Esta guía asume que **no tienes experiencia previa** subiendo código. Sigue los pasos
en orden, uno por uno. Toma unos 20-30 minutos la primera vez.

---

## Paso 1 — Crear la base de datos (Firebase, gratis)

Aquí es donde se van a guardar todos tus datos, compartidos entre los dos socios.

1. Ve a **https://console.firebase.google.com** y entra con una cuenta de Google.
2. Clic en **"Crear un proyecto"**. Ponle el nombre que quieras (ej. "mb-services").
   Puedes desactivar Google Analytics, no lo necesitas.
3. Ya dentro del proyecto, en la pantalla principal, clic en el ícono **`</>`** (agregar app web).
4. Ponle un apodo (ej. "app") y clic en **"Registrar app"**. NO actives Firebase Hosting.
5. Te va a mostrar un bloque de código con un objeto `firebaseConfig = {...}`. **Copia esos valores.**
6. Abre el archivo `src/firebase.js` de este proyecto y reemplaza los valores de ejemplo
   por los tuyos (apiKey, authDomain, projectId, etc.)
7. En el menú de la izquierda de Firebase, ve a **"Firestore Database"** → **"Crear base de datos"**.
   - Elige **"Iniciar en modo de prueba"** (esto permite leer/escribir sin login — suficiente para
     este uso interno, pero cualquiera con el link de tu app podría ver los datos. Si quieres más
     seguridad después, se puede agregar una contraseña simple o autenticación real).
   - Elige la región más cercana a ti y confirma.

Con esto, la base de datos ya está lista.

---

## Paso 2 — Conseguir tu llave de la API de Anthropic (para el escaneo de facturas)

Esto es opcional — si no lo haces, todo funciona excepto el botón "Escanear factura (IA)".

1. Ve a **https://console.anthropic.com** y crea una cuenta (o entra si ya tienes).
2. Ve a **"API Keys"** y crea una llave nueva. Cópiala (empieza con `sk-ant-...`).
3. Guárdala, la vas a necesitar en el Paso 4. Es de pago por uso (no por membresía) —
   cada foto de factura cuesta centavos de dólar, no dólares completos.

---

## Paso 3 — Subir el código a GitHub

1. Ve a **https://github.com** y crea una cuenta gratis si no tienes.
2. Clic en **"New repository"**, ponle nombre (ej. "mb-services-app"), y créalo.
3. Sube TODOS los archivos de esta carpeta a ese repositorio (puedes arrastrarlos
   directamente desde la página de GitHub con "uploading an existing file", o usar
   GitHub Desktop si prefieres una app con ventanas).

---

## Paso 4 — Publicar la app (Vercel, gratis)

1. Ve a **https://vercel.com** y entra con tu cuenta de GitHub.
2. Clic en **"Add New" → "Project"**, y elige el repositorio que acabas de subir.
3. Vercel detecta automáticamente que es un proyecto Vite — no cambies nada ahí.
4. Antes de darle a "Deploy", abre la sección **"Environment Variables"** y agrega:
   - Nombre: `ANTHROPIC_API_KEY`
   - Valor: la llave que copiaste en el Paso 2 (si te la saltaste, puedes agregar esto después)
5. Clic en **"Deploy"**. En 1-2 minutos te da un link (algo como `mb-services-app.vercel.app`).

**Ese link ya es tu app**, funcionando en internet, en PC y en celular.

---

## Paso 5 — Instalarla como app en el celular

1. Abre el link de Vercel en el navegador del celular (Chrome en Android, Safari en iPhone).
2. Toca el menú (⋮ en Android, compartir ⬆️ en iPhone).
3. Elige **"Agregar a pantalla de inicio"** / **"Instalar app"**.

Te va a quedar un ícono como cualquier otra app, y al abrirlo no se ve la barra del navegador.

---

## ¿Cómo se actualiza la app después?

Cualquier cambio que quieras (agregar un campo, cambiar un color, etc.) se hace
editando los archivos y volviendo a subirlos a GitHub — Vercel los publica solos
en automático cada vez que subes cambios al repositorio.

---

## Notas importantes

- **Los datos son compartidos**: tú y tu socio van a ver la misma información en tiempo real,
  sin necesidad de refrescar la página.
- **Seguridad**: con las reglas de "modo de prueba" de Firebase, cualquiera con el link de tu
  app podría en teoría leer o modificar los datos. Para un uso interno entre 2 socios esto
  suele ser aceptable, pero si quieres cerrarlo más, se puede agregar un login simple más adelante.
- **Costo**: Firebase y Vercel son gratis en este nivel de uso. Lo único con costo real es
  el escaneo de facturas con IA (centavos por foto).
