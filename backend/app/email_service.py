from __future__ import annotations

import smtplib
import socket
import ssl
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from .config import Settings


def send_pdf_email(
    settings: Settings,
    recipient_email: str,
    pdf_bytes: bytes,
    filename: str,
    original_filename: str = "",
) -> None:
    if not settings.smtp_sender_email or not settings.smtp_sender_password:
        raise RuntimeError("SMTP credentials are not configured.")

    msg = MIMEMultipart()
    msg["From"] = settings.smtp_sender_email
    msg["To"] = recipient_email
    msg["Subject"] = f"Viveka AI Research Dossier — {original_filename or filename}"

    body = (
        "Your Viveka AI research dossier is attached.\n\n"
        "This document contains the full verbatim transcript, executive synthesis, "
        "and AWESOME qualitative mapping artifacts generated from your audio session.\n\n"
        "— Viveka AI Platform"
    )
    msg.attach(MIMEText(body, "plain"))

    attachment = MIMEBase("application", "octet-stream")
    attachment.set_payload(pdf_bytes)
    encoders.encode_base64(attachment)
    attachment.add_header(
        "Content-Disposition",
        f'attachment; filename="{filename}"',
    )
    msg.attach(attachment)

    smtp_hosts_to_try = [settings.smtp_host]
    if settings.smtp_host == "smtp.gmail.com":
        smtp_hosts_to_try.append("smtp-relay.gmail.com")
        smtp_hosts_to_try.append("aspmx.l.google.com")
    
    last_error = None
    for smtp_host in smtp_hosts_to_try:
        try:
            if settings.smtp_use_tls:
                context = ssl.create_default_context()
                with smtplib.SMTP(smtp_host, settings.smtp_port, timeout=30) as server:
                    server.ehlo()
                    server.starttls(context=context)
                    server.ehlo()
                    server.login(settings.smtp_sender_email, settings.smtp_sender_password)
                    server.sendmail(settings.smtp_sender_email, recipient_email, msg.as_string())
                return
            else:
                with smtplib.SMTP_SSL(smtp_host, settings.smtp_port, timeout=30) as server:
                    server.login(settings.smtp_sender_email, settings.smtp_sender_password)
                    server.sendmail(settings.smtp_sender_email, recipient_email, msg.as_string())
                return
        except (socket.gaierror, socket.timeout, OSError) as e:
            last_error = e
            continue
    
    if last_error:
        raise RuntimeError(f"Failed to send email: {last_error}")
