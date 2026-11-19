use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use nine_grid_core::RuleError;
use serde::Serialize;
use thiserror::Error;

/// 应用层错误。
///
/// 规则错误（[`RuleError`]）在这里被翻译成 HTTP 语义，
/// 未来搬上链时，同一批错误会被翻译成 `require!` 的报错码 —— 映射关系是一一对应的。
#[derive(Debug, Error)]
pub enum AppError {
    #[error("对局不存在")]
    NotFound,

    /// 业务冲突：房间满了、不是你的回合、格子被占……
    #[error("{message}")]
    Conflict { code: &'static str, message: String },

    #[error("{0}")]
    BadRequest(String),

    #[error("{0}")]
    Forbidden(String),

    #[error("数据库错误: {0}")]
    Database(#[from] sqlx::Error),

    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::Conflict {
            code,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into())
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::Forbidden(message.into())
    }

    /// 规则引擎的错误 → HTTP 错误
    pub fn from_rule(err: RuleError) -> Self {
        match err {
            RuleError::OutOfRange => Self::bad_request(err.to_string()),
            RuleError::UnknownState => Self::Internal(err.to_string()),
            // 轮次不对、格子被占、已终局、对手没来，都是"当前状态不允许这个操作"
            _ => Self::conflict(err.code(), err.to_string()),
        }
    }

    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::NotFound => (StatusCode::NOT_FOUND, "game_not_found"),
            Self::Conflict { code, .. } => (StatusCode::CONFLICT, code),
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::Forbidden(_) => (StatusCode::FORBIDDEN, "not_a_player"),
            Self::Database(_) | Self::Internal(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
            }
        }
    }
}

#[derive(Debug, Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();

        // 数据库 / 内部错误只记日志，不把细节漏给客户端
        let message = match &self {
            Self::Database(err) => {
                tracing::error!(error = %err, "数据库操作失败");
                "服务器内部错误，请稍后重试".to_owned()
            }
            Self::Internal(detail) => {
                tracing::error!(detail, "内部错误");
                "服务器内部错误，请稍后重试".to_owned()
            }
            other => other.to_string(),
        };

        let body = ErrorBody {
            error: ErrorDetail { code, message },
        };
        (status, Json(body)).into_response()
    }
}
