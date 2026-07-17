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
