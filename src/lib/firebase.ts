import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
    apiKey: "AIzaSyDq0X64s2w532lTZ8XcTdLU8JRzOAabEHw",
    authDomain: "beatbattle-e02aa.firebaseapp.com",
    databaseURL: "https://beatbattle-e02aa-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "beatbattle-e02aa",
    storageBucket: "beatbattle-e02aa.firebasestorage.app",
    messagingSenderId: "1041147594033",
    appId: "1:1041147594033:web:5b3ce470b89f221b695c10"
};

// Initialize Firebase (Singleton pattern)
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const storage = getStorage(app);

export { app, auth, db, storage };
