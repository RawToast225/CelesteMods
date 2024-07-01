import { base64StringToArrayBuffer } from "./base64StringToArrayBuffer";




/** Imports an RSA public key.
 * Assumes base64 encoding, spki format, and RSA-PSS algorithm with SHA-256 hash.
 * Non-extractable, only for verifying signatures.
*/
export const importPublicKey = (publicKeyString: string): Promise<CryptoKey> => {
    const binaryDer = base64StringToArrayBuffer(publicKeyString);

    // parse the DER-encoded binary data
    const publicKey = crypto.subtle.importKey(
        "spki",
        binaryDer,
        {
            name: "RSA-PSS",
            hash: "SHA-256",
        },
        false,
        ["verify"],
    );


    return publicKey;
};