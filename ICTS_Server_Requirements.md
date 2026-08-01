# Server Infrastructure Requirements for Viveka AI Platform

**Prepared for**: ICTS, Amrita Vishwa Vidyapeetham  
**Project**: Viveka AI — Qualitative Verbatim Transcription & Analysis Platform  
**Date**: June 22, 2026  
**Prepared by**: Ammachi Labs Development Team

---

## Executive Summary

The Viveka AI platform currently processes large audio files (100MB–1GB+) for qualitative research transcription and analysis. To handle production workloads efficiently and cost-effectively, we require dedicated server infrastructure to replace cloud-based Redis services and support background job processing for large file uploads.

**Current Challenge**: Redis Cloud free tier (30MB) is insufficient for processing 100MB+ audio files, and paid tiers incur significant recurring costs.

**Proposed Solution**: Dedicated ICTS server with Redis, PostgreSQL, and sufficient compute resources to handle concurrent audio processing jobs.

---

## 1. Technical Requirements

### 1.1 Server Specifications

| Component | Minimum Requirement | Recommended |
|-----------|-------------------|-------------|
| **CPU** | 4 vCPUs | 8 vCPUs |
| **RAM** | 8 GB | 16 GB |
| **Storage** | 100 GB SSD | 250 GB SSD |
| **Network** | 100 Mbps | 1 Gbps |
| **OS** | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |

**Rationale**:
- **CPU**: Parallel audio chunk processing (4-8 concurrent workers)
- **RAM**: Redis in-memory storage for job queues + FFmpeg audio processing
- **Storage**: Temporary audio file storage during processing (auto-cleanup after 24 hours)
- **Network**: Fast upload/download for 100MB–1GB audio files

---

### 1.2 Software Stack

#### Required Services
1. **Redis Server** (v7.0+)
   - Purpose: Background job queue and progress tracking
   - Memory requirement: 4-8 GB allocated
   - Configuration: Persistent storage enabled (AOF + RDB)

2. **PostgreSQL Database** (v15+)
   - Purpose: User authentication, session management, audit logs
   - Storage requirement: 10 GB (grows with user base)
   - Configuration: Daily automated backups

3. **Docker** (v24.0+)
   - Purpose: Containerized deployment of Viveka backend service
   - Required for: Isolated environment, easy updates, dependency management

4. **Nginx** (v1.24+)
   - Purpose: Reverse proxy, SSL termination, load balancing
   - Configuration: HTTPS with Let's Encrypt SSL certificates

#### System Dependencies
- Python 3.11+
- FFmpeg (latest stable)
- Node.js 20+ (for frontend build, if hosting frontend on same server)

---

### 1.3 Network & Security Requirements

| Requirement | Details |
|-------------|---------|
| **Public IP Address** | Static IP for DNS mapping |
| **Domain Name** | Subdomain under `amrita.edu` (e.g., `viveka.amrita.edu`) |
| **SSL Certificate** | Let's Encrypt or institutional certificate |
| **Firewall Rules** | Allow ports: 80 (HTTP), 443 (HTTPS), 22 (SSH - restricted IPs) |
| **Backup Access** | Daily automated backups to ICTS backup infrastructure |

**Security Considerations**:
- SSH access restricted to Ammachi Labs team IPs
- Database access only from localhost (no external exposure)
- Redis access only from localhost (no external exposure)
- All external traffic via HTTPS only

---

## 2. Use Case & Workload Profile

### 2.1 Current Usage Patterns

| Metric | Current Volume | Projected (6 months) |
|--------|---------------|---------------------|
| **Active Users** | 15-20 researchers | 50-100 researchers |
| **Daily Uploads** | 5-10 files | 20-50 files |
| **Average File Size** | 50-150 MB | 100-300 MB |
| **Peak File Size** | 1 GB | 2 GB |
| **Processing Time** | 10-30 min/file | 10-30 min/file |
| **Concurrent Jobs** | 2-4 | 4-8 |

### 2.2 Why Redis is Critical

**Current Architecture**:
- Large audio files (100MB–1GB) are split into 10-minute chunks
- Each chunk is transcribed via Deepgram API (external service)
- Redis stores:
  - Job queue for background processing
  - Real-time progress updates (0-100%)
  - Intermediate transcription results
  - Session state for long-running jobs

**Without Redis**:
- ❌ Users must keep browser open for 30+ minutes during processing
- ❌ No ability to resume interrupted jobs
- ❌ No concurrent job processing (one file at a time)
- ❌ Server memory exhaustion with multiple large files

**With Redis**:
- ✅ Users can close browser and check back later
- ✅ Jobs survive server restarts
- ✅ 4-8 files can process concurrently
- ✅ Efficient memory management

---

## 3. Deployment Architecture

### 3.1 Proposed Server Setup

```
┌─────────────────────────────────────────────────────┐
│  ICTS Server (viveka.amrita.edu)                    │
│                                                      │
│  ┌──────────────────────────────────────────────┐  │
│  │  Nginx (Reverse Proxy + SSL)                 │  │
│  │  - Port 443 (HTTPS)                          │  │
│  └──────────────────────────────────────────────┘  │
│                       │                              │
│  ┌──────────────────────────────────────────────┐  │
│  │  Viveka Backend (Docker Container)           │  │
│  │  - FastAPI application                       │  │
│  │  - Port 8000 (internal)                      │  │
│  │  - Background workers (Redis Queue)          │  │
│  └──────────────────────────────────────────────┘  │
│                       │                              │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │   Redis     │  │ PostgreSQL  │  │  /var/data │ │
│  │   (Queue)   │  │   (Auth)    │  │  (Temp)    │ │
│  └─────────────┘  └─────────────┘  └────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 3.2 Data Flow

1. **User uploads audio** → Nginx → Backend API
2. **Backend enqueues job** → Redis job queue
3. **Background worker picks job** → Processes audio chunks
4. **Progress updates** → Stored in Redis → Sent to frontend via SSE
5. **Final results** → Stored in PostgreSQL → Displayed to user
6. **Temporary files** → Auto-deleted after 24 hours

---

## 4. Cost-Benefit Analysis

### 4.1 Current Cloud Costs (Monthly)

| Service | Provider | Cost |
|---------|----------|------|
| Redis Cloud (1GB) | Redis Labs | ₹2,500 |
| Backend Hosting | Render.com | ₹1,500 |
| Database | Neon.tech | ₹0 (free tier) |
| **Total** | | **₹4,000/month** |

**Annual Cost**: ₹48,000

### 4.2 ICTS Server (One-Time + Minimal Recurring)

| Component | Cost |
|-----------|------|
| Server provisioning | ₹0 (ICTS infrastructure) |
| Electricity & maintenance | Covered by ICTS |
| Domain & SSL | ₹0 (institutional) |
| **Total Annual** | **₹0** |

**Savings**: ₹48,000/year

### 4.3 Additional Benefits

- ✅ **Data sovereignty**: All research data stays within Amrita infrastructure
- ✅ **No vendor lock-in**: Full control over infrastructure
- ✅ **Scalability**: Can upgrade RAM/CPU as needed without recurring costs
- ✅ **Reliability**: ICTS uptime SLA + backup infrastructure
- ✅ **Compliance**: Meets institutional data security policies

---

## 5. Implementation Plan

### Phase 1: Server Provisioning (Week 1)
- [ ] ICTS allocates server with specified requirements
- [ ] Ammachi Labs team receives SSH access
- [ ] Install base OS (Ubuntu 22.04 LTS)
- [ ] Configure firewall rules

### Phase 2: Software Setup (Week 2)
- [ ] Install Docker, Redis, PostgreSQL, Nginx
- [ ] Configure Redis persistence and memory limits
- [ ] Set up PostgreSQL with automated backups
- [ ] Configure Nginx reverse proxy with SSL

### Phase 3: Application Deployment (Week 3)
- [ ] Deploy Viveka backend Docker container
- [ ] Migrate database from Neon.tech to ICTS PostgreSQL
- [ ] Configure Redis job queue and workers
- [ ] Test with sample audio files

### Phase 4: Production Cutover (Week 4)
- [ ] Update DNS to point to ICTS server
- [ ] Monitor for 48 hours with existing users
- [ ] Decommission cloud services (Render, Redis Cloud)
- [ ] Document operational procedures for ICTS team

**Total Timeline**: 4 weeks

---

## 6. Operational Support Requirements

### 6.1 From ICTS Team

**Initial Setup** (one-time):
- Server provisioning and network configuration
- Firewall rule setup
- Domain name and SSL certificate setup

**Ongoing** (minimal):
- Server monitoring and uptime alerts
- Automated daily backups (PostgreSQL + Redis snapshots)
- OS security updates (monthly)

### 6.2 From Ammachi Labs Team

**Ongoing**:
- Application updates and bug fixes
- User support and training
- Monitoring application logs
- Database maintenance (cleanup old sessions)

**Estimated Time Commitment**:
- ICTS: 2-4 hours/month (mostly automated)
- Ammachi Labs: 5-10 hours/month

---

## 7. Risk Mitigation

| Risk | Mitigation Strategy |
|------|-------------------|
| **Server downtime** | Daily automated backups; documented recovery procedure |
| **Storage exhaustion** | Auto-cleanup of temp files after 24 hours; monitoring alerts |
| **High CPU load** | Job queue limits concurrent processing to 4-8 files |
| **Security breach** | SSH key-only access; no external database exposure; regular updates |
| **Data loss** | PostgreSQL daily backups; Redis AOF persistence; 30-day retention |

---

## 8. Success Metrics

After deployment, we will track:

| Metric | Target |
|--------|--------|
| **Server uptime** | > 99.5% |
| **Average processing time** | < 15 min for 100MB file |
| **Concurrent job capacity** | 4-8 files simultaneously |
| **User satisfaction** | > 90% positive feedback |
| **Cost savings** | ₹48,000/year vs. cloud services |

---

## 9. Contact & Support

**Primary Contact**:  
Ammachi Labs Development Team  
Email: [Your team email]  
Phone: [Your contact number]

**Technical Lead**:  
[Your name]  
Email: [Your email]

**Project Supervisor**:  
[Supervisor name]  
Ammachi Labs, Amrita Vishwa Vidyapeetham

---

## 10. Conclusion

The Viveka AI platform requires dedicated server infrastructure to:
1. **Eliminate recurring cloud costs** (₹48,000/year savings)
2. **Enable efficient processing** of large audio files (100MB–1GB)
3. **Ensure data sovereignty** within Amrita infrastructure
4. **Scale to support** 50-100 researchers within 6 months

We request ICTS support in provisioning a server with the specifications outlined in Section 1. The Ammachi Labs team will handle all application deployment and ongoing maintenance, requiring minimal ICTS involvement post-setup.

**Estimated Timeline**: 4 weeks from server allocation to production deployment.

---

**Appendix A**: Detailed Redis Configuration  
**Appendix B**: PostgreSQL Backup Strategy  
**Appendix C**: Docker Deployment Scripts  

*(Available upon request)*
