// API contract stubs — interfaces only, no implementation yet

// POST /auth/otp/request
export interface OtpRequestBody {
  phone: string;
}

export interface OtpRequestResponse {
  success: boolean;
  message: string;
}

// POST /auth/otp/verify
export interface OtpVerifyBody {
  phone: string;
  otp: string;
}

export interface OtpVerifyResponse {
  success: boolean;
  token?: string;
  message: string;
}

// POST /auth/login/staff
export interface PasswordLoginBody {
  email: string;
  password: string;
}

export interface PasswordLoginResponse {
  success: boolean;
  token?: string;
  role?: string;
  message: string;
}

// POST /api/v1/workers
export interface CreateWorkerBody {
  name: string;
  phone: string;
}

// PATCH /api/v1/workers/:id/verify
export interface VerifyWorkerBody {
  status: 'APPROVED' | 'SUSPENDED';
}

