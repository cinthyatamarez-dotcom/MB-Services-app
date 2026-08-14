// Configuración de Firebase.
// 1. Ve a https://console.firebase.google.com, crea un proyecto gratis.
// 2. Dentro del proyecto, crea una "Web app" (ícono </>).
// 3. Copia el objeto de configuración que te da y pégalo aquí abajo, reemplazando el de ejemplo.
// 4. En el menú lateral, ve a "Firestore Database" → "Crear base de datos" → modo de prueba está bien para empezar.
//
// Ver instrucciones completas en README.md

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyBbcU0FuMMa3EnFhLQYIGLnCVKGbXK9Twk",
  authDomain: "mb-services-a5127.firebaseapp.com",
  projectId: "mb-services-a5127",
  storageBucket: "mb-services-a5127.firebasestorage.app",
  messagingSenderId: "891236892504",
  appId: "1:891236892504:web:10aa2d8b71e6a70dc2ef2d",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
