/** Generates a new backend signing key pair. Put the secret in backend/.env and the public key in mobile/src/config.ts. */
import nacl from 'tweetnacl';

const kp = nacl.sign.keyPair();
console.log(`SERVER_SIGNING_SECRET_KEY=${Buffer.from(kp.secretKey).toString('base64')}`);
console.log(`SERVER_PUBLIC_KEY (mobile/src/config.ts)=${Buffer.from(kp.publicKey).toString('base64')}`);
