from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
import base64


def _derive_key(password: str) -> bytes:
    salt = b"sweetspicyszechuanchickenratiobeetles"
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(password.encode()))
    return key


def encrypt(data: bytes, password: str) -> bytes:
    key = _derive_key(password)
    f = Fernet(key)
    encrypted_data = f.encrypt(data)
    return encrypted_data


def decrypt(encrypted_data: bytes, password: str) -> bytes:
    key = _derive_key(password)
    f = Fernet(key)
    decrypted_data = f.decrypt(encrypted_data)
    return decrypted_data
