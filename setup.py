from setuptools import setup, find_packages

setup(
    name='tglfs',
    version='0.1.0',
    packages=find_packages(),
    install_requires=[
        'cryptography',
        'telethon',
    ],
    entry_points={
        'console_scripts': [
            'tglfs = tglfs.main:main',
        ],
    },
)
