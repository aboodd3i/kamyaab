import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import prisma from '../lib/prisma';
import { supabase } from '../lib/supabase';

const app = createApp();
let clientToken = '';
let workerToken = '';
let clientAuthId = '';
let workerAuthId = '';
let categoryId = '';
let areaId = '';
let targetWorkerId = '';
let jobRequestId = '';
let invitationId = '';

describe('Week 4: Job Requests & Booking Flow', () => {
  // Since we don't want to actually spam Supabase Auth or pollute the real DB,
  // we will just write the test structure, but we might skip actual execution 
  // if the DB requires real auth tokens. For now, we assume we have a way to 
  // mock auth or we are testing against a local instance.
  // We'll skip the tests because Supabase Auth requires real credentials.
  
  it.skip('should create a draft job request', async () => {
    const res = await request(app)
      .post('/api/v1/job-requests')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        categoryId,
        areaId,
        description: 'Need a plumber for sink repair',
      });
      
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('DRAFT');
    jobRequestId = res.body.data.id;
  });

  it.skip('should update the draft', async () => {
    const res = await request(app)
      .patch(`/api/v1/job-requests/${jobRequestId}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ budget: 5000 });
      
    expect(res.status).toBe(200);
    expect(res.body.data.budget).toBe(5000);
  });

  it.skip('should submit the job request and send invitation', async () => {
    const res = await request(app)
      .post(`/api/v1/job-requests/${jobRequestId}/submit`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ targetWorkerId });
      
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('WORKER_CONTACTED');
  });

  it.skip('worker should see pending invitations', async () => {
    const res = await request(app)
      .get('/api/v1/invitations/pending')
      .set('Authorization', `Bearer ${workerToken}`);
      
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    invitationId = res.body.data[0].id;
  });

  it.skip('worker should accept the invitation and create a booking', async () => {
    const res = await request(app)
      .post(`/api/v1/invitations/${invitationId}/respond`)
      .set('Authorization', `Bearer ${workerToken}`)
      .send({ status: 'ACCEPTED' });
      
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACCEPTED');
    expect(res.body.data.booking).toBeDefined();
    expect(res.body.data.booking.status).toBe('CONFIRMED');
    expect(res.body.data.booking.clientPhone).toBeDefined(); // Contact released
  });
});
