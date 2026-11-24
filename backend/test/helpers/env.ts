export const PROJECT_ID = 'demo-konum';
export const REGION = 'europe-west1';
export const HOST = '127.0.0.1';
export const AUTH_HOST = `${HOST}:9099`;
export const FIRESTORE_HOST = `${HOST}:8080`;
export const DB_HOST = `${HOST}:9000`;
export const FUNCTIONS_URL = `http://${HOST}:5001/${PROJECT_ID}/${REGION}`;
/**
 * RTDB ad alanı. demo- projelerinde Functions emülatörünün Admin SDK'sı `https://<proje>.firebaseio.com`
 * (ad alanı = proje kimliği) kullanır; firebase.json kuralları da `.firebaserc` hedefiyle (live → demo-konum)
 * AYNI ad alanına yüklenir. rules-unit-testing varsayılanı da budur.
 */
export const RTDB_NS = PROJECT_ID;
export const RTDB_URL = `http://${DB_HOST}/?ns=${RTDB_NS}`;
