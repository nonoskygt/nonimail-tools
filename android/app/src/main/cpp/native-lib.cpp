// Arranca Node.js (nodejs-mobile) dentro de la app y manda su salida a logcat (etiqueta "NoniMail").
#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>
#include "node.h"

static int pipe_out[2], pipe_err[2];
static const char *TAG = "NoniMail";

static void *pump(void *arg) {
    int fd = *(int *)arg;
    int prio = fd == pipe_err[0] ? ANDROID_LOG_WARN : ANDROID_LOG_INFO;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(prio, TAG, buf);
    }
    return nullptr;
}

static void redirect_output() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pipe_out); pipe(pipe_err);
    dup2(pipe_out[1], STDOUT_FILENO);
    dup2(pipe_err[1], STDERR_FILENO);
    pthread_t t1, t2;
    pthread_create(&t1, nullptr, pump, &pipe_out[0]); pthread_detach(t1);
    pthread_create(&t2, nullptr, pump, &pipe_err[0]); pthread_detach(t2);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_nonosky_nonimail_NodeService_startNode(JNIEnv *env, jclass, jobjectArray arguments) {
    // Node pide que todos los argumentos estén en un solo bloque de memoria contiguo
    jsize argc = env->GetArrayLength(arguments);
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring)env->GetObjectArrayElement(arguments, i);
        total += env->GetStringUTFLength(s) + 1;
    }
    char *block = (char *)calloc(total, 1);
    char **argv = (char **)calloc(argc + 1, sizeof(char *));
    char *pos = block;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring)env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        size_t len = strlen(c);
        memcpy(pos, c, len);
        argv[i] = pos;
        pos += len + 1;
        env->ReleaseStringUTFChars(s, c);
    }
    redirect_output();
    return (jint)node::Start((int)argc, argv);
}
