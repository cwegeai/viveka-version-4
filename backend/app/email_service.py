from __future__ import annotations

import smtplib
import ssl
from email.mime.application import MIMEApplication
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

    attachment = MIMEApplication(pdf_bytes, _subtype="pdf")
    attachment.add_header(
        "Content-Disposition",
        f'attachment; filename="{filename}"',
    )
    msg.attach(attachment)

    try:
        if settings.smtp_use_tls:
            context = ssl.create_default_context()
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=settings.smtp_timeout_seconds) as server:
                server.ehlo()
                server.starttls(context=context)
                server.ehlo()
                server.login(settings.smtp_sender_email, settings.smtp_sender_password)
                server.sendmail(settings.smtp_sender_email, recipient_email, msg.as_string())
            return

        with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=settings.smtp_timeout_seconds) as server:
            server.login(settings.smtp_sender_email, settings.smtp_sender_password)
            server.sendmail(settings.smtp_sender_email, recipient_email, msg.as_string())
    except smtplib.SMTPException as exc:
        raise RuntimeError(f"Failed to send email: {exc}") from exc
    except OSError as exc:
        raise RuntimeError(f"Failed to send email: {exc}") from exc
