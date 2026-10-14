from pathlib import Path
from datetime import datetime,timedelta,timezone
import argparse,ipaddress,json
from cryptography import x509
from cryptography.x509.oid import NameOID,ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa

parser=argparse.ArgumentParser()
parser.add_argument('--directory',required=True)
parser.add_argument('--hosts',nargs='*',default=[])
args=parser.parse_args()
root=Path(args.directory).resolve();private=root/'private';public=root/'public'
private.mkdir(parents=True,exist_ok=True);public.mkdir(parents=True,exist_ok=True)
now=datetime.now(timezone.utc)
key_path=private/'ca-key.pem';ca_path=private/'ca-cert.pem'
if key_path.exists()!=ca_path.exists():
    raise RuntimeError('Incomplete local certificate authority; preserve existing files and repair manually')
if not key_path.exists():
    key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
    name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Campus Traffic Admin Local CA')])
    cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=1095))
        .add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True)
        .add_extension(x509.KeyUsage(digital_signature=False,content_commitment=False,key_encipherment=False,data_encipherment=False,key_agreement=False,key_cert_sign=True,crl_sign=True,encipher_only=False,decipher_only=False),critical=True)
        .add_extension(x509.NameConstraints(permitted_subtrees=[x509.DNSName('localhost'),x509.IPAddress(ipaddress.ip_network('10.0.0.0/8')),x509.IPAddress(ipaddress.ip_network('127.0.0.0/8'))],excluded_subtrees=None),critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()),critical=False).sign(key,hashes.SHA256()))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    ca_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
else:
    key=serialization.load_pem_private_key(key_path.read_bytes(),password=None)
    cert=x509.load_pem_x509_certificate(ca_path.read_bytes())
    if cert.not_valid_after_utc < now+timedelta(days=30):
        raise RuntimeError('Local CA expires soon; renew and distribute explicitly')
hosts=sorted(set(['127.0.0.1']+args.hosts))
for host in hosts:
    address=ipaddress.ip_address(host)
    if not(address.is_loopback or address in ipaddress.ip_network('10.0.0.0/8')):
        raise ValueError('Only loopback and campus 10.x addresses are allowed')
leaf_path=private/'server-cert.pem';leaf_key=private/'server-key.pem'
renew=True
if leaf_path.exists() and leaf_key.exists():
    leaf=x509.load_pem_x509_certificate(leaf_path.read_bytes())
    covered={str(value) for value in leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.IPAddress)}
    renew=not(set(hosts)<=covered) or leaf.not_valid_after_utc<now+timedelta(days=7) or leaf.issuer!=cert.subject
if renew:
    server_key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    leaf=(x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Campus Traffic Administrator')]))
        .issuer_name(cert.subject).public_key(server_key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now-timedelta(minutes=5)).not_valid_after(min(now+timedelta(days=90),cert.not_valid_after_utc))
        .add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]+[x509.IPAddress(ipaddress.ip_address(host)) for host in hosts]),critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),critical=False)
        .add_extension(x509.KeyUsage(digital_signature=True,content_commitment=False,key_encipherment=True,data_encipherment=False,key_agreement=False,key_cert_sign=False,crl_sign=False,encipher_only=False,decipher_only=False),critical=True)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()),critical=False)
        .sign(key,hashes.SHA256()))
    leaf_key.write_bytes(server_key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    leaf_path.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
(public/'campus-admin-ca.cer').write_bytes(cert.public_bytes(serialization.Encoding.DER))
(public/'campus-admin-ca.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
fingerprint=cert.fingerprint(hashes.SHA256()).hex().upper()
(root/'certificate-info.json').write_text(json.dumps({'sha256':fingerprint,'hosts':hosts,'leafExpires':leaf.not_valid_after_utc.isoformat(),'leafFingerprint':leaf.fingerprint(hashes.SHA256()).hex().upper()},indent=2),encoding='utf-8')
print('Administrator TLS certificate ready for: '+', '.join(hosts))
