cmake_minimum_required(VERSION 3.22.1)
project(nonimail)

# libnode.so y sus cabeceras vienen de nodejs-mobile (scripts/android-prepare.js los deja en app/libnode)
set(LIBNODE_DIR ${CMAKE_SOURCE_DIR}/../../../libnode)
include_directories(${LIBNODE_DIR}/include/node)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

add_library(native-lib SHARED native-lib.cpp)
target_link_libraries(native-lib libnode log)
target_link_options(native-lib PRIVATE "-Wl,-z,max-page-size=16384")
