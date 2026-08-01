#!/usr/bin/env python3
"""Test SMTP email sending with the configured credentials."""

import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent))

from app.config import get_settings
from app.email_service import send_pdf_email


def main():
    settings = get_settings()
    
    print("SMTP Configuration:")
    print(f"  Host: {settings.smtp_host}")
    print(f"  Port: {settings.smtp_port}")
    print(f"  Sender: {settings.smtp_sender_email}")
    print(f"  Password: {'*' * len(settings.smtp_sender_password) if settings.smtp_sender_password else '(not set)'}")
    print(f"  TLS: {settings.smtp_use_tls}")
    print()
    
    if not settings.smtp_sender_email or not settings.smtp_sender_password:
        print("ERROR: SMTP credentials not configured!")
        print("Set SMTP_SENDER_EMAIL and SMTP_SENDER_PASSWORD in your .env file")
        return 1
    
    # Create a test PDF
    test_pdf = b"%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n2 0 obj\n<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n3 0 obj\n<<\n/Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 612 792]\n>>\nendobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer\n<<\n/Size 4\n/Root 1 0 R\n>>\nstartxref\n190\n%%EOF"
    
    recipient = input(f"Enter recipient email (or press Enter to use {settings.smtp_sender_email}): ").strip()
    if not recipient:
        recipient = settings.smtp_sender_email
    
    print(f"\nSending test email to {recipient}...")
    
    try:
        send_pdf_email(
            settings=settings,
            recipient_email=recipient,
            pdf_bytes=test_pdf,
            filename="test_viveka_dossier.pdf",
            original_filename="SMTP_Test_Audio.mp3"
        )
        print("✅ Email sent successfully!")
        print(f"Check {recipient} inbox for the test dossier.")
        return 0
    except Exception as e:
        print(f"❌ Failed to send email: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
